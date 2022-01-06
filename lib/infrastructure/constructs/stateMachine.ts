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
import {Duration, RemovalPolicy} from "aws-cdk-lib";
import {
    Choice,
    Condition,
    LogLevel,
    Pass,
    StateMachine,
    StateMachineType,
    Map,
    Fail, Succeed
} from "aws-cdk-lib/aws-stepfunctions";
import {Construct} from 'constructs';
import {LambdaInvoke} from "aws-cdk-lib/aws-stepfunctions-tasks";

import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";
import {Runtime, Tracing} from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import {AZTable} from "./database";
import {LogGroup} from "aws-cdk-lib/aws-logs";
import {Operation, Status} from "../../runtime/lib/model";
import {Effect, PolicyStatement} from "aws-cdk-lib/aws-iam";
import {Table} from "aws-cdk-lib/aws-dynamodb";
import {NagSuppressions} from "cdk-nag";

export interface LambdaProps {
    memorySize: number,
    timeout: Duration,
}

export interface AZFailAwayStateMachineProps {
    azTable: AZTable
    tracing: Tracing

}

export class AZFailAwayStateMachine extends Construct {

    readonly stateMachine: StateMachine

    constructor(scope: Construct, id: string, props: AZFailAwayStateMachineProps) {
        super(scope, id)
        const findAllASGsThatUseThisAzFn = this.findAllASGsThatUseThisAz(props.tracing, 256, Duration.seconds(30))
        const lookupASGsThatPreviouslyUsedThisAzFn = this.lookupASGsThatPreviouslyUsedThisAz(props.azTable.table, props.tracing, 256, Duration.seconds(30))
        const removeAzFromAsgFn = this.removeAzFromAsg(props.tracing, 256, Duration.seconds(30))
        const restoreAzToAsgFn = this.restoreAzToAsg(props.tracing, 256, Duration.seconds(30))

        const addUpdateAutoScalingGroupEventFn = this.addUpdateAutoScalingGroupEvent(props.azTable.table, props.tracing, 256, Duration.seconds(30))
        const deleteUpdateAutoScalingGroupEventFn = this.deleteUpdateAutoScalingGroupEvent(props.azTable.table, props.tracing, 256, Duration.seconds(30))

        /*
            Initial payload is
            {
              "zoneId":"string",
              "operation": "FAIL|RESTORE"
            }
         */

        const start = new Pass(this, "Start")
        const areWeFailingAwayFromOrRestoringThisAz = new Choice(this, "Are we failing away from or restoring this AZ")
        const definition = start
            .next(areWeFailingAwayFromOrRestoringThisAz
                .when(Condition.stringEquals("$.operation", Operation.Remove),
                    new LambdaInvoke(this, "Find all ASGs that use this AZ", {
                        lambdaFunction: findAllASGsThatUseThisAzFn,
                        outputPath: "$.Payload"
                    })
                        .next(new Map(this, "Remove AZ from ASGs", {
                                maxConcurrency: 3,
                                inputPath: "$",
                                outputPath: "$",

                            }).iterator(
                                new LambdaInvoke(this, "Remove AZ from ASG", {
                                    lambdaFunction: removeAzFromAsgFn,
                                    outputPath: "$.Payload"
                                }).next(
                                    new Choice(this, "Did the remove succeed?")
                                        .when(Condition.stringEquals("$.status", Status.Success),
                                            new LambdaInvoke(this, "Add UpdateAutoScalingGroupEvent for AZ", {
                                                lambdaFunction: addUpdateAutoScalingGroupEventFn,
                                                outputPath: "$.Payload"
                                            })
                                                .next(
                                                    new Choice(this, "Did the add succeed?")
                                                        .when(Condition.stringEquals("$.status", Status.Success),
                                                            new Pass(this, "Add succeeded"))
                                                        .otherwise(new Fail(this, "Add failed"))))
                                        .otherwise(new Fail(this, "AZ removal failed failed"))
                                )
                            )
                        )
                )
                .otherwise(
                    new LambdaInvoke(this, "Lookup ASGs that previously used this AZ", {
                        lambdaFunction: lookupASGsThatPreviouslyUsedThisAzFn,
                        outputPath: "$.Payload"
                    })
                        .next(new Map(this, "Restore AZ to ASGs", {
                                maxConcurrency: 3,
                                inputPath: "$",
                                outputPath: "$",

                            }).iterator(
                                new LambdaInvoke(this, "Restore AZ to ASG", {
                                    lambdaFunction: restoreAzToAsgFn,
                                    outputPath: "$.Payload"
                                })
                                    .next(
                                        new Choice(this, "Did the restore succeed?")
                                            .when(Condition.stringEquals("$.status", Status.Success),
                                                new LambdaInvoke(this, "Delete UpdateAutoScalingGroupEvent for AZ", {
                                                    lambdaFunction: deleteUpdateAutoScalingGroupEventFn,
                                                    outputPath: "$.Payload"
                                                })
                                                    .next(
                                                        new Choice(this, "Did the delete succeed?")
                                                            .when(Condition.stringEquals("$.status", Status.Success), new Pass(this, "Delete succeeded"))
                                                            .otherwise(new Fail(this, "Delete failed"))))
                                            .otherwise(new Fail(this, "Restore failed")))
                            )
                        )
                )
            )
        const logGroup = new LogGroup(this, "az-fail-away-state-machine-log-group", {
            logGroupName: `/az-fail-away/stateMachine/`,
            removalPolicy: RemovalPolicy.DESTROY

        })
        this.stateMachine = new StateMachine(this, "az-fail-away-state-machine", {
            logs: {
                destination: logGroup,
                level: LogLevel.ALL,
                includeExecutionData: true
            },
            stateMachineType: StateMachineType.STANDARD,
            stateMachineName: "az-fail-away-state-machine",
            definition: definition,
            tracingEnabled: true
        })
        NagSuppressions.addResourceSuppressions(this.stateMachine, [{
            id: "AwsSolutions-IAM5",
            reason: "* resource in this case is for X-Ray support",

        }], true)
        props.azTable.grantReadData(lookupASGsThatPreviouslyUsedThisAzFn)

    }

    findAllASGsThatUseThisAz(tracing: Tracing = Tracing.ACTIVE, memorySize: number = 256, timeout: Duration = Duration.seconds(30)): NodejsFunction {
        const fn = new NodejsFunction(this, "findAllASGsThatUseThisAz", {
            memorySize: memorySize,
            timeout: timeout,
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/findAllASGsThatUseThisAz.ts`),
            tracing: tracing

        });
        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["autoscaling:DescribeAutoScalingGroups"],
            effect: Effect.ALLOW,
            resources: ["*"]

        }))
        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["ec2:DescribeAvailabilityZones"],
            effect: Effect.ALLOW,
            resources: ["*"]

        }))
        NagSuppressions.addResourceSuppressions(fn, [{
            id: "AwsSolutions-IAM5",
            reason: "This function needs to be able to describe all scaling groups and availability zone to function",

        }], true)
        return fn
    }

    lookupASGsThatPreviouslyUsedThisAz(table: Table, tracing: Tracing = Tracing.ACTIVE, memorySize: number = 256, timeout: Duration = Duration.seconds(30)): NodejsFunction {
        const fn = new NodejsFunction(this, "lookupASGsThatPreviouslyUsedThisAz", {
            memorySize: memorySize,
            timeout: timeout,
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/lookupASGsThatPreviouslyUsedThisAz.ts`),
            environment: {
                "TABLE_NAME": table.tableName
            },
            tracing: tracing

        });
        table.grantReadData(fn)
        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["autoscaling:DescribeAutoScalingGroups"],
            effect: Effect.ALLOW,
            resources: ["*"]

        }))
        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["ec2:DescribeSubnets"],
            effect: Effect.ALLOW,
            resources: ["*"]
        }))
        NagSuppressions.addResourceSuppressions(fn, [{
            id: "AwsSolutions-IAM5",
            reason: "This function needs to be able to describe all scaling groups and subnets to function",

        }], true)
        return fn
    }

    removeAzFromAsg(tracing: Tracing = Tracing.ACTIVE, memorySize: number = 256, timeout: Duration = Duration.seconds(30)): NodejsFunction {
        const fn = new NodejsFunction(this, "removeAzFromAsg", {
            memorySize: memorySize,
            timeout: timeout,
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/removeAzFromAsg.ts`),

            tracing: tracing

        });

        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["autoscaling:UpdateAutoScalingGroup"],
            effect: Effect.ALLOW,
            resources: ["*"]
        }))
        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["ec2:DescribeSubnets"],
            effect: Effect.ALLOW,
            resources: ["*"]
        }))
        NagSuppressions.addResourceSuppressions(fn, [ {
            id: "AwsSolutions-IAM5",
            reason: "This function needs to be able to update all scaling groups and describe all subnets to remove bad AZ from ASGs",

        }], true)
        return fn
    }

    restoreAzToAsg(tracing: Tracing = Tracing.ACTIVE, memorySize: number = 256, timeout: Duration = Duration.seconds(30)): NodejsFunction {
        const fn = new NodejsFunction(this, "restoreAzToAsg", {
            memorySize: memorySize,
            timeout: timeout,
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/restoreAzToAsg.ts`),

            tracing: tracing

        });

        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["autoscaling:UpdateAutoScalingGroup"],
            effect: Effect.ALLOW,
            resources: ["*"]
        }))
        fn.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
            actions: ["ec2:DescribeSubnets"],
            effect: Effect.ALLOW,
            resources: ["*"]
        }))
        NagSuppressions.addResourceSuppressions(fn, [{
            id: "AwsSolutions-IAM5",
            reason: "This function needs to be able to update all scaling groups and describe all subnets to restore repaired AZs back to ASGs that were failed away",

        }], true)
        return fn
    }

    addUpdateAutoScalingGroupEvent(table: Table, tracing: Tracing = Tracing.ACTIVE, memorySize: number = 256, timeout: Duration = Duration.seconds(30)): NodejsFunction {
        const fn = new NodejsFunction(this, "addUpdateAutoScalingGroupEvent", {
            memorySize: memorySize,
            timeout: timeout,
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/addUpdateAutoScalingGroupEvent.ts`),
            environment: {
                "TABLE_NAME": table.tableName
            },
            tracing: tracing

        });
        table.grantReadWriteData(fn)
        NagSuppressions.addResourceSuppressions(fn, [{
            id: "AwsSolutions-IAM5",
            reason: "* resource in this case is for X-Ray support",

        }], true)
        return fn
    }

    deleteUpdateAutoScalingGroupEvent(table: Table, tracing: Tracing = Tracing.ACTIVE, memorySize: number = 256, timeout: Duration = Duration.seconds(30)): NodejsFunction {
        const fn = new NodejsFunction(this, "deleteUpdateAutoScalingGroupEvent", {
            memorySize: memorySize,
            timeout: timeout,
            runtime: Runtime.NODEJS_14_X,
            handler: "lambdaHandler",
            entry: path.join(__dirname, `/../../runtime/functions/deleteUpdateAutoScalingGroupEvent.ts`),
            environment: {
                "TABLE_NAME": table.tableName
            },
            tracing: tracing

        });
        table.grantReadWriteData(fn)
        NagSuppressions.addResourceSuppressions(fn, [{
            id: "AwsSolutions-IAM5",
            reason: "* resource in this case is for X-Ray support",

        }], true)
        return fn
    }
}