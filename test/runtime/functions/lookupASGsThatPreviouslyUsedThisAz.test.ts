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
    OperationEvent,
    Status,
    UpdateAutoScalingGroupEvent
} from "../../../lib/runtime/lib/model";
import * as AWSXRay from "aws-xray-sdk";
import {lambdaHandler} from "../../../lib/runtime/functions/removeAzFromAsg";
import {Context} from "aws-lambda";
import * as sinon from "sinon";
import {AutoScalingClient, UpdateAutoScalingGroupCommand} from "@aws-sdk/client-auto-scaling";
import {
    addUpdateAutoScalingGroupEvent,
    lookupASGsThatPreviouslyUsedThisAz,
    removeAzFromAsg
} from "../../../lib/runtime/functions/functions";
import {DescribeSubnetsCommand, EC2Client, DescribeSubnetsCommandOutput} from "@aws-sdk/client-ec2";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";

test("Can lookup ASGs That Previously Used This Az", () => {
    const event = {
        "operation": "Restore",
        "timestamp": 1640717953614,
        "zoneId": "use2-az1",
        "region": "us-east-2",
        "accountId": "123456789012"
    }

    const incomingEvent = JSON.parse(JSON.stringify(event)) as OperationEvent
    AWSXRay.setContextMissingStrategy("IGNORE_ERROR");

    const dynamodbClient = sinon.createStubInstance(DynamoDBClient)
    dynamodbClient.send.resolves({
        $metadata: {
            httpStatusCode: 200
        },
        Item: {
            "pk": {
                "S": "123456789012::use2-az1"
            },
            "events": {
                "M": {
                    "test-asg-01": {
                        "S": "{\"availabilityZones\":[\"us-east-2b\",\"us-east-2c\"],\"subnetIds\":[\"subnet-0778ab3187fdbfe37\",\"subnet-09e77b41e33b9b69d\"],\"status\":\"Success\",\"details\":{\"autoScalingGroupName\":\"test-asg-01\",\"autoScalingGroupARN\":\"arn:aws:autoscaling:us-east-2:123456789012:autoScalingGroup:517f7fa1-3fce-4ed9-9b4b-b15e281a529c:autoScalingGroupName/test-asg-01\",\"zoneName\":\"us-east-2a\",\"subnetIds\":[\"subnet-0778ab3187fdbfe37\",\"subnet-0c775f4df04b75521\",\"subnet-09e77b41e33b9b69d\"],\"availabilityZones\":[\"us-east-2a\",\"us-east-2b\",\"us-east-2c\"],\"operationEvent\":{\"operation\":\"Remove\",\"timestamp\":1640707455663,\"zoneId\":\"use2-az1\",\"region\":\"us-east-2\",\"accountId\":\"123456789012\"}}}"
                    }
                }
            }
        }

    })
    const ec2Client = sinon.createStubInstance(EC2Client)
    ec2Client.send.resolves(Promise.resolve({
            Subnets: [{SubnetId: "subnet-0c775f4df04b75521"}]
        })
    )

    const autoScalingClient = sinon.createStubInstance(AutoScalingClient)
    autoScalingClient.send.resolves(Promise.resolve({
                "AutoScalingGroups": [
                    {
                        "AutoScalingGroupName": "test-asg-01",
                        "AutoScalingGroupARN": "arn:aws:autoscaling:us-east-2:123456789012:autoScalingGroup:517f7fa1-3fce-4ed9-9b4b-b15e281a529c:autoScalingGroupName/test-asg-01",

                        "AvailabilityZones": [
                            "us-east-2a",
                            "us-east-2b",
                            "us-east-2c"
                        ],
                        "VPCZoneIdentifier": "subnet-0778ab3187fdbfe37,subnet-09e77b41e33b9b69d"

                    }
                ]
            }
        )
    )

    return lookupASGsThatPreviouslyUsedThisAz(incomingEvent, dynamodbClient as any, autoScalingClient as any, ec2Client as any).then((promises) => {
        if (promises.length == 0) {
            fail("Expected results")
        }
        for (const p of promises) {
            p.then(value => {
                if(value!=null) {
                    expect(value.autoScalingGroupName).toBe("test-asg-01")
                    expect(value.subnetIds).toEqual(expect.arrayContaining(["subnet-0778ab3187fdbfe37", "subnet-09e77b41e33b9b69d", "subnet-0c775f4df04b75521"]))
                }else{
                    throw new Error("Results should not contain null")
                }
            })
        }
    })
})

