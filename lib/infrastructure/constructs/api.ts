/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *  software and associated documentation files (the "Software"), to deal in the Software
 *  without restriction, including without limitation the rights to use, copy, modify,
 *  merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 *  permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 *  INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 *  PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *  HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 *  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 *  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 */

import {CfnOutput, Duration, RemovalPolicy} from 'aws-cdk-lib';
import {CfnIntegration, CfnRoute, CfnStage} from 'aws-cdk-lib/aws-apigatewayv2'
import {HttpApi, HttpConnectionType, HttpMethod} from "@aws-cdk/aws-apigatewayv2-alpha";

import {LogGroup} from "aws-cdk-lib/aws-logs";

import {Construct} from "constructs";
import {Runtime, Tracing} from "aws-cdk-lib/aws-lambda";
import {AZFailAwayStateMachine} from "./stateMachine";
import {Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";

import {HttpLambdaIntegration} from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import * as path from "path";
import {NagSuppressions} from "cdk-nag";

export interface ApiProps {
    stateMachine: AZFailAwayStateMachine

}

export class Api extends Construct {
    readonly api: HttpApi

    constructor(scope: Construct, id: string,props:ApiProps) {
        super(scope, id);
        this.api = new HttpApi(this, "az-fail-away", {
            apiName: `az-fail-away`,
            createDefaultStage: true
        })


        const apiLogGroup = new LogGroup(this, "az-fail-away-api-log-group", {
            logGroupName: "/az-fail-away/api/",
            removalPolicy: RemovalPolicy.DESTROY

        })
        const defaultStage = this.api.defaultStage?.node.defaultChild as CfnStage
        defaultStage.accessLogSettings = {
            destinationArn: apiLogGroup.logGroupArn,
            format: JSON.stringify({
                "requestId": "$context.requestId",
                "ip": "$context.identity.sourceIp",
                "caller": "$context.identity.caller",
                "user": "$context.identity.user",
                "requestTime": "$context.requestTime",
                "httpMethod": "$context.httpMethod",
                "resourcePath": "$context.resourcePath",
                "status": "$context.status",
                "protocol": "$context.protocol",
                "responseLength": "$context.responseLength"
            })
        }

        const invokeStepFunction= new NodejsFunction(this, "invokeStepFunction", {
            memorySize: 128,
            timeout: Duration.seconds(5),
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/invokeStepFunction.ts`),
            environment: {
                STATE_MACHINE_ARN: props.stateMachine.stateMachine.stateMachineArn
            },
            tracing: Tracing.ACTIVE,

        });
        NagSuppressions.addResourceSuppressions(invokeStepFunction, [{
            id: "AwsSolutions-IAM5",
            reason: "* resource in this case is for X-Ray support",

        }], true)
        props.stateMachine.stateMachine.grantStartExecution(invokeStepFunction)
        const invokeStepFunctionProxy=new HttpLambdaIntegration("invoke-step-function-proxy",invokeStepFunction)

        this.api.addRoutes({
            path: "/",
            methods: [HttpMethod.POST],
            integration: invokeStepFunctionProxy,
        });


        new CfnOutput(this, "api-endpoint",{
            value: `${this.api.apiEndpoint}`,
            description:"The api endpoint",
        })
    }
}