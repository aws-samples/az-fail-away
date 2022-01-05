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

import {
    AutoScalingGroupDetails,
    Operation,
    OperationEvent,
    SaveAzInfo,
    Status,
    UpdateAutoScalingGroupEvent
} from "../lib/model";
import {
    DescribeAvailabilityZonesCommand,
    DescribeSubnetsCommand,
    DescribeSubnetsCommandOutput,
    EC2Client,
    Filter
} from "@aws-sdk/client-ec2";
import {
    AutoScalingClient, DescribeAutoScalingGroupsCommand,
    paginateDescribeAutoScalingGroups,
    UpdateAutoScalingGroupCommand
} from "@aws-sdk/client-auto-scaling";
import {
    AttributeValue,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import {SFNClient, StartExecutionCommand} from "@aws-sdk/client-sfn";
import {APIGatewayProxyEvent, APIGatewayProxyResult, Context} from "aws-lambda";

export function zoneIdToZoneName(operationEvent: OperationEvent, client: EC2Client = new EC2Client({region: operationEvent.region})): Promise<string> {
    const filters: Filter[] = [{
        Name: "zone-id",
        Values: [operationEvent.zoneId]
    }]
    if (operationEvent.region != null) {
        filters.push({
            Name: "region-name",
            Values: [operationEvent.region]
        })
    }
    const response = client.send(new DescribeAvailabilityZonesCommand({
        Filters: filters
    })).then((value) => {
        if (value.AvailabilityZones != null && value.AvailabilityZones.length > 0) {
            const zoneName = value.AvailabilityZones[0].ZoneName
            if (zoneName != null) {
                return zoneName
            }
        }
        throw new Error(`Could not get zoneName for zoneId: ${operationEvent.zoneId}: ${operationEvent}`)

    })

    return response
}

export function restoreAzToAsg(event: AutoScalingGroupDetails, autoScalingClient: AutoScalingClient = new AutoScalingClient({region: event.operationEvent.region}), ec2Client: EC2Client = new EC2Client({region: event.operationEvent.region})): Promise<UpdateAutoScalingGroupEvent> {

    let azs: string[] = []
    if (event.availabilityZones != null && event.availabilityZones.length > 0) {
        azs = azs.concat(event.availabilityZones)
        azs.push(event.zoneName)
    } else {
        azs.push(event.zoneName)
    }
    return updateAsg(azs, event, autoScalingClient, ec2Client)
}

export function removeAzFromAsg(event: AutoScalingGroupDetails, autoScalingClient: AutoScalingClient = new AutoScalingClient({region: event.operationEvent.region}), ec2Client: EC2Client = new EC2Client({region: event.operationEvent.region})): Promise<UpdateAutoScalingGroupEvent> {
    let azs: string[] = []
    if (event.availabilityZones != null && event.availabilityZones.length > 0) {
        const filteredAzs = event.availabilityZones.filter((element) => {
            return element != event.zoneName
        })
        azs = azs.concat(filteredAzs)
    } else {
        //can't remove a zone if there are none there
        throw Error(`No AZs specified for ASG: ${event.autoScalingGroupName}: ${event}`)
    }
    return updateAsg(azs, event, autoScalingClient, ec2Client)
}

export function updateAsg(azs: string[], event: AutoScalingGroupDetails, autoScalingClient: AutoScalingClient = new AutoScalingClient({}), ec2Client: EC2Client = new EC2Client({})): Promise<UpdateAutoScalingGroupEvent> {
    let result: UpdateAutoScalingGroupEvent
    return ec2Client.send(new DescribeSubnetsCommand({
        Filters: [{
            Name: "availability-zone",
            Values: azs
        }],
        SubnetIds: event.subnetIds

    })).then((describeSubnetsCommandResponse: DescribeSubnetsCommandOutput) => {

        const subnetIds = describeSubnetsCommandResponse.Subnets?.map(subnet => {
            return subnet.SubnetId!
        })

        return autoScalingClient.send(new UpdateAutoScalingGroupCommand({
            AutoScalingGroupName: event.autoScalingGroupName,
            AvailabilityZones: azs,
            VPCZoneIdentifier: subnetIds?.join(",")

        })).then((response) => {
            if (response.$metadata.httpStatusCode == 200) {
                console.log(`ASG ${event.autoScalingGroupName} successfully updated`)
                result = {
                    availabilityZones: azs,
                    subnetIds: subnetIds,
                    status: Status.Success,
                    details: event

                }

            } else {
                result = {
                    availabilityZones: azs,
                    subnetIds: subnetIds,
                    status: Status.Failed,
                    details: event

                }
            }
            return result
        }).catch(error => {
            console.error(`ASG ${event.autoScalingGroupName} failed updated: ${error}`)
            return {
                availabilityZones: azs,
                subnetIds: subnetIds,
                status: Status.Failed,
                details: event

            }
        })
    })

}

export function getAutoScalingGroupDetails(event: AutoScalingGroupDetails, autoScalingClient = new AutoScalingClient({region: event.operationEvent.region})): Promise<AutoScalingGroupDetails | null> {
    const describeAutoScalingGroup = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [event.autoScalingGroupName!],
    })
    return autoScalingClient.send(describeAutoScalingGroup).then(value => {
        if (value.AutoScalingGroups != null && value.AutoScalingGroups.length > 0) {
            const details = value.AutoScalingGroups.map(value1 => {
                console.log(`getAutoScalingGroupDetails: ${JSON.stringify(value)}`)
                return {
                    autoScalingGroupName: value1.AutoScalingGroupName,
                    autoScalingGroupARN: value1.AutoScalingGroupARN,
                    zoneName: event.zoneName,
                    subnetIds: value1.VPCZoneIdentifier?.split(","),
                    availabilityZones: value1.AvailabilityZones,
                    operationEvent: event.operationEvent

                } as AutoScalingGroupDetails
            })
            return details[0]
        } else {
            return null
        }

    }).catch(reason => {
        console.warn(`Problem looking up getAutoScalingGroupDetails: ${reason}`)
        return null
    })

}

export function findAllASGsThatUseThisAz(event: OperationEvent, autoScalingClient = new AutoScalingClient({region: event.region}), ec2Client = new EC2Client({region: event.region})): Promise<() => Promise<AutoScalingGroupDetails[]>> {

    return zoneIdToZoneName(event, ec2Client).then(zoneName => {
        const paginator = paginateDescribeAutoScalingGroups({
            client: autoScalingClient,
            pageSize: 100,
        }, {})
        return (async () => {
            const results: AutoScalingGroupDetails[] = []
            for await (const page of paginator) {
                if (page.AutoScalingGroups != null && page.AutoScalingGroups.length > 0) {
                    page.AutoScalingGroups.filter((element, index, array) => {
                        if (element.AvailabilityZones != null && element.AvailabilityZones.length > 0) {
                            return element.AvailabilityZones.includes(zoneName)
                        }
                        return false
                    }).forEach(value => {

                        results.push({
                            autoScalingGroupName: value.AutoScalingGroupName,
                            autoScalingGroupARN: value.AutoScalingGroupARN,
                            zoneName: zoneName,
                            subnetIds: value.VPCZoneIdentifier?.split(","),
                            availabilityZones: value.AvailabilityZones,
                            operationEvent: event

                        })
                    })
                }
            }
            return results
        })

    })

}

export function lookupASGsThatPreviouslyUsedThisAz(event: OperationEvent, dynamoDbClient: DynamoDBClient = new DynamoDBClient({region: event.region}), autoScalingClient = new AutoScalingClient({region: event.region}), ec2Client: EC2Client = new EC2Client({region: event.region})): Promise<Promise<AutoScalingGroupDetails | null>[]> {
    if (event.operation == Operation.Restore) {
        const id = `${event.accountId}::${event.zoneId}`
        const getItem: GetItemCommand = new GetItemCommand({
            Key: {
                "pk": {
                    S: id
                }
            },
            ConsistentRead: true,

            TableName: process.env.TABLE_NAME!
        })
        return dynamoDbClient.send(getItem).then(results => {
            let savedDetails: AutoScalingGroupDetails[]
            if (results.Item != null) {
                const item = results.Item
                const asgsToEvents = item["events"]["M"]!
                savedDetails = Object.keys(asgsToEvents).filter(asgName => {
                    return asgsToEvents[asgName] != null
                }).map(asgName => {
                    const eventString = asgsToEvents[asgName]["S"]!
                    const savedEvent = JSON.parse(eventString) as UpdateAutoScalingGroupEvent
                    const savedAutoScalingGroupDetails = savedEvent.details
                    return savedAutoScalingGroupDetails

                })

            } else {
                console.warn(`No item found for id: ${id} `)
                savedDetails = []
            }
            return savedDetails

        }).then(value => {

            return value.map(savedAutoScalingGroupDetails => {
                return getAutoScalingGroupDetails(savedAutoScalingGroupDetails, autoScalingClient).then(upToDateAutoScalingGroupDetails => {
                    if (upToDateAutoScalingGroupDetails != null) {
                        return ec2Client.send(new DescribeSubnetsCommand({
                            Filters: [{
                                Name: "availability-zone",
                                Values: [savedAutoScalingGroupDetails.zoneName]
                            }]

                        })).then(subnets => {
                            if (subnets.Subnets != null) {
                                const subnetsToRestore = subnets.Subnets.filter((subnet) => {
                                    if (savedAutoScalingGroupDetails.subnetIds != null && subnet.SubnetId != null) {
                                        return savedAutoScalingGroupDetails.subnetIds.indexOf(subnet.SubnetId) > -1
                                    }
                                    return false
                                }).map((subnet) => {
                                    return subnet.SubnetId!
                                })
                                // console.log(`subnetsToRestore: ${subnetsToRestore}`)
                                if (upToDateAutoScalingGroupDetails.subnetIds != null) {
                                    upToDateAutoScalingGroupDetails.subnetIds = upToDateAutoScalingGroupDetails.subnetIds.concat(subnetsToRestore)
                                } else {
                                    upToDateAutoScalingGroupDetails.subnetIds = subnetsToRestore
                                }

                            } else {
                                console.warn(`No subnets found for availability zone ${savedAutoScalingGroupDetails.zoneName}`)
                            }

                            return upToDateAutoScalingGroupDetails
                        })
                    } else {
                        console.warn(`Could not retrieve current information for ASG ${savedAutoScalingGroupDetails.autoScalingGroupName}`)
                        return null
                    }

                })
            }) as Promise<AutoScalingGroupDetails | null>[]

        })

    } else {
        throw new Error("Invalid operation")
    }
}

export function addUpdateAutoScalingGroupEvent(event: UpdateAutoScalingGroupEvent, dynamoDbClient: DynamoDBClient = new DynamoDBClient({region: event.details.operationEvent.region})): Promise<SaveAzInfo> {
    const id = `${event.details.operationEvent.accountId}::${event.details.operationEvent.zoneId}`
    const eventString = JSON.stringify(event)
    console.log(`Add ${id} - ${event.details.operationEvent.timestamp.toString()} = ${eventString}`)
    const putItem: PutItemCommand = new PutItemCommand({
        Item: {
            "pk": {
                S: id
            },
            "events": {
                M: {}
            }
        },
        ConditionExpression: "attribute_not_exists(events)",
        TableName: process.env.TABLE_NAME!
    })
    const resolve = (() => {
        const updateItem: UpdateItemCommand = new UpdateItemCommand({
            Key: {
                "pk": {
                    S: id
                },

            },
            UpdateExpression: "SET events.#asg = :event",
            ExpressionAttributeNames: {
                "#asg": event.details.autoScalingGroupName!

            },
            ExpressionAttributeValues: {
                ":event": {
                    S: eventString
                }

            },
            TableName: process.env.TABLE_NAME!
        });
        return saveAzInfo(updateItem, event, dynamoDbClient)
    })

    return dynamoDbClient.send(putItem).then(response => {
        return resolve()
    }).catch(reason => {
        if (reason.name == "ConditionalCheckFailedException") {
            return resolve()
        } else {
            throw reason
        }

    })

}

export function deleteUpdateAutoScalingGroupEvent(event: UpdateAutoScalingGroupEvent, dynamoDbClient: DynamoDBClient = new DynamoDBClient({region: event.details.operationEvent.region})): Promise<SaveAzInfo> {
    const id = `${event.details.operationEvent.accountId}::${event.details.operationEvent.zoneId}`
    const eventString = JSON.stringify(event)
    console.log(`Delete ${id} - ${event.details.operationEvent.timestamp.toString()} = ${eventString}`)
    const updateItem: UpdateItemCommand = new UpdateItemCommand({
        Key: {
            "pk": {
                S: id
            },

        },
        UpdateExpression: "REMOVE events.#asg",
        ExpressionAttributeNames: {
            "#asg": event.details.autoScalingGroupName!

        },
        TableName: process.env.TABLE_NAME!
    });
    return saveAzInfo(updateItem, event, dynamoDbClient)

}

export function saveAzInfo(updateItem: UpdateItemCommand, event: UpdateAutoScalingGroupEvent, dynamoDbClient: DynamoDBClient = new DynamoDBClient({region: event.details.operationEvent.region})): Promise<SaveAzInfo> {
    if (event.status == Status.Success) {

        return dynamoDbClient.send(updateItem).then(value => {
            return {
                status: Status.Success,
                event: event
            }
        }).catch(reason => {
            console.log(`Problem saving AZ info: ${reason.message} - ${JSON.stringify(reason)}`)
            return {
                status: Status.Failed,
                event: event
            }
        })
    } else {
        return Promise.resolve({
            status: Status.Failed,
            event: event
        })
    }

}

export function invokeStepFunction(apiGatewayProxyEvent: APIGatewayProxyEvent, context: Context, sfnClient: SFNClient = new SFNClient({})): Promise<APIGatewayProxyResult> {
    const event = JSON.parse(apiGatewayProxyEvent.body!) as OperationEvent
    const input: OperationEvent = {
        operation: event.operation,
        timestamp: apiGatewayProxyEvent.requestContext.requestTimeEpoch != null ? apiGatewayProxyEvent.requestContext.requestTimeEpoch : Date.now(),
        zoneId: event.zoneId,
        region: event.region != null ? event.region : process.env.AWS_REGION,
        accountId: event.accountId != null ? event.accountId : context.invokedFunctionArn.split(":")[4]

    }
    console.log(`OperationEvent: ${JSON.stringify(input)}`)
    return sfnClient.send(new StartExecutionCommand({
        input: JSON.stringify(input),
        stateMachineArn: process.env.STATE_MACHINE_ARN
    })).then(value => {
        return {
            statusCode: value.$metadata.httpStatusCode!,
            body: JSON.stringify({
                "executionArn": value.executionArn,
                "startDate": value.startDate
            })
        }
    }).catch(reason => {
        console.error(`Problem invoking step function: ${reason} `)
        return {
            statusCode: reason.statusCode,
            body: JSON.stringify(reason)
        }
    })
}