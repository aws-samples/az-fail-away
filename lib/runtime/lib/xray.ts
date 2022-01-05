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

import * as AWSXRay from "aws-xray-sdk";
import {  Context } from "aws-lambda";
import { Subsegment } from "aws-xray-sdk";

export type Handler<TEvent = any, TResult = any> = (
    event: TEvent,
    context: Context,
) => Promise<void | TResult>;

export const xrayScope = <TEvent, TResult>(fn: (segment?: Subsegment ) => Handler<TEvent, TResult>,name:string): Handler<TEvent, TResult> => async (e, c) => {
    AWSXRay.captureHTTPsGlobal(require("http"), true);
    AWSXRay.captureHTTPsGlobal(require("https"), true);
    AWSXRay.capturePromise();
    const segment = AWSXRay.getSegment()?.addNewSubsegment(name);
    if(segment!=null) {
        try {
            return await fn(segment)(e, c) as TResult
        } finally {
            if (!segment.isClosed()) {
                segment.close();
            }
        }
    }else{
        return await fn(undefined)(e, c) as TResult
    }
};