'use strict';

const path = require('path');
const fs = require('fs');
const _ = require('lodash');

class Plugin {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.provider = this.serverless.getProvider('aws');

        this.hooks = {
            'package:createDeploymentArtifacts': this.beforeDeployCreateDeploymentArtifacts.bind(this),
            'package:compileEvents': this.deployCompileEvents.bind(this),
            'after:deploy:deploy': this.afterDeployDeploy.bind(this)
        };
    }

    getEnvFilePath() {
        return path.join(this.serverless.config.servicePath, 'sumologic-shipping-function');
    }

    beforeDeployCreateDeploymentArtifacts() {
        if (!!this.serverless.service.custom.shipLogs.arn) {
            //use existing specified handler ARN
            return;
        }

        this.serverless.cli.log('Adding Cloudwatch to Sumologic lambda function');
        let functionPath = this.getEnvFilePath();

        if (!fs.existsSync(functionPath)) {
            fs.mkdirSync(functionPath);
        }

        let templatePath = path.resolve(__dirname, '../sumologic-function/handler.template.js');

        let templateFile = fs.readFileSync(templatePath, 'utf-8');

        let collectorUrl = this.serverless.service.custom.shipLogs.collectorUrl;

        let handlerFunction = templateFile.replace('%collectorUrl%', collectorUrl);

        let customRole = this.serverless.service.custom.shipLogs.role;

        fs.writeFileSync(path.join(functionPath, 'handler.js'), handlerFunction);

        this.serverless.service.functions.sumologicShipping = {
            handler: 'sumologic-shipping-function/handler.handler',
            events: []
        };

        if (!!customRole) {
            this.serverless.service.functions.sumologicShipping.role = customRole
        }
    }

    deployCompileEvents() {
        this.serverless.cli.log('Generating subscription filters');
        let filterPattern = !!this.serverless.service.custom.shipLogs.filterPattern ? this.serverless.service.custom.shipLogs.filterPattern : "[timestamp=*Z, request_id=\"*-*\", event]";

        let destinationArn = null;
        if (!!this.serverless.service.custom.shipLogs.arn) {
            destinationArn = this.serverless.service.custom.shipLogs.arn;
        } else {
            destinationArn = {
                "Fn::GetAtt": [
                    "SumologicShippingLambdaFunction",
                    "Arn"
                ]
            };
        }

        const filterBaseStatement = {
            Type: "AWS::Logs::SubscriptionFilter",
            Properties: {
                DestinationArn: destinationArn,
                FilterPattern: filterPattern
            },
            DependsOn: ["cloudwatchLogsLambdaPermission"]
        };

        Object.freeze(filterBaseStatement); // Make it immutable

        const principal = `logs.${this.serverless.service.provider.region}.amazonaws.com`;

        let cloudwatchLogsLambdaPermission = {
            Type: "AWS::Lambda::Permission",
            Properties: {
                FunctionName: destinationArn,
                Action: "lambda:InvokeFunction",
                Principal: principal
            }
        };

        this.serverless.service.provider.compiledCloudFormationTemplate.Resources.cloudwatchLogsLambdaPermission = cloudwatchLogsLambdaPermission;

        this.serverless.service.getAllFunctions().forEach((functionName) => {
            if (functionName !== 'sumologicShipping') {
                const functionObj = this.serverless.service.getFunction(functionName);

                // We will be able to do this soon
                // const logGroupLogicalId = this.provider.naming.getLogGroupLogicalId(functionName);

                const logGroupLogicalId = getLogGroupLogicalId(functionName)

                let filterStatement = filterBaseStatement;

                filterStatement.Properties.LogGroupName = `/aws/lambda/${functionObj.name}`;

                let filterStatementName = getNormalizedFunctionName(functionName) + 'SumoLogicSubscriptionFilter';

                filterStatement.DependsOn.push(logGroupLogicalId);

                let newFilterStatement = {
                    [`${filterStatementName}`]: filterStatement
                };

                _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, newFilterStatement);
            }
        });
    }

    afterDeployDeploy() {
        this.serverless.cli.log('Removing temporary Cloudwatch to Sumologic lambda function');
        let functionPath = this.getEnvFilePath();

        try {
            if (fs.existsSync(functionPath)) {
                if (fs.existsSync(path.join(functionPath, 'handler.js'))) {
                    fs.unlinkSync(path.join(functionPath, 'handler.js'));
                }
                fs.rmdirSync(functionPath);
            }
        } catch (err) {
            throw new Error(err);
        }
    }
}

module.exports = Plugin;

// Remove after 1.1.1 release
function normalizeName(name) {
    return `${_.upperFirst(name)}`;
}

function getNormalizedFunctionName(functionName) {
    return normalizeName(functionName
        .replace(/-/g, 'Dash')
        .replace(/_/g, 'Underscore'));
}

function getLogGroupLogicalId(functionName) {
    return `${getNormalizedFunctionName(functionName)}LogGroup`;
}
