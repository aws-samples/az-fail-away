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

import {AutoScalingGroupDetails, Status} from "../../../lib/runtime/lib/model";
import * as AWSXRay from "aws-xray-sdk";
import {lambdaHandler} from "../../../lib/runtime/functions/removeAzFromAsg";
import {Context} from "aws-lambda";
import * as sinon from "sinon";
import {AutoScalingClient, UpdateAutoScalingGroupCommand} from "@aws-sdk/client-auto-scaling";
import {removeAzFromAsg} from "../../../lib/runtime/functions/functions";
import {DescribeSubnetsCommand, EC2Client, DescribeSubnetsCommandOutput} from "@aws-sdk/client-ec2";

test("Can remove an AZ", () => {
    const event = {
        "autoScalingGroupName": "test-asg-01",
        "autoScalingGroupARN": "arn:aws:autoscaling:us-east-2:123456789012:autoScalingGroup:517f7fa1-3fce-4ed9-9b4b-b15e281a529c:autoScalingGroupName/test-asg-01",
        "zoneName": "us-east-2a",
        "subnetIds": ["subnet-0778ab3187fdbfe37", "subnet-09e77b41e33b9b69d", "subnet-0c775f4df04b75521"],
        "availabilityZones": [
            "us-east-2a",
            "us-east-2b",
            "us-east-2c"
        ],
        "operationEvent": {
            "zoneId": "use2-az1",
            "operation": "Remove"
        }
    }

    const incomingEvent = JSON.parse(JSON.stringify(event)) as AutoScalingGroupDetails
    AWSXRay.setContextMissingStrategy("IGNORE_ERROR");

    const autoScalingClient = sinon.createStubInstance(AutoScalingClient)
    autoScalingClient.send.resolves({
        $metadata: {
            httpStatusCode: 200
        }
    })
    const ec2Client = sinon.createStubInstance(EC2Client)
    ec2Client.send.resolves(Promise.resolve({
            Subnets: [{SubnetId: "subnet-0778ab3187fdbfe37"}, {SubnetId: "subnet-09e77b41e33b9b69d"}]
        })
    )

    return removeAzFromAsg(incomingEvent, autoScalingClient as any, ec2Client as any).then((value) => {

        expect(value.status).toBe(Status.Success)
        expect(value.availabilityZones).not.toContain("us-east-2a")
        expect(value.subnetIds).not.toContain("subnet-0c775f4df04b75521")

    })
})

