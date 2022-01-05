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
import {RemovalPolicy} from "aws-cdk-lib";
import {AttributeType, BillingMode, Table, TableEncryption} from "aws-cdk-lib/aws-dynamodb";
import {Function} from "aws-cdk-lib/aws-lambda";


import {Construct} from "constructs";

export class AZTable extends Construct {
    readonly table: Table

    constructor(scope: Construct, id: string) {
        super(scope, id)
        this.table = new Table(this, "az-table", {
            billingMode: BillingMode.PAY_PER_REQUEST,
            encryption: TableEncryption.AWS_MANAGED,
            partitionKey: {
                name: "pk",
                type: AttributeType.STRING
            },
            pointInTimeRecovery: true
        })

        this.table.applyRemovalPolicy(RemovalPolicy.DESTROY)
    }

    public grantReadWriteData(...functions: Function[]) {
        for (let f of functions) {
            this.table.grantReadWriteData(f)
        }
    }

    public grantReadData(...functions: Function[]) {
        for (let f of functions) {
            this.table.grantReadData(f)
        }
    }
}