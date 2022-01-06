#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {AZFailAwayStack, Route53ArcStack, TestAsgStack} from '../lib/infrastructure/stacks/stacks';
import {Tracing} from "aws-cdk-lib/aws-lambda";
import {Duration} from "aws-cdk-lib";
import {AwsSolutionsChecks, NagSuppressions} from "cdk-nag"

const app = new cdk.App();
const env={
    account: app.node.tryGetContext("account"),
    region: app.node.tryGetContext("region")
}
if (env.account==null || env.region==null){
    throw Error("Specify account and region via cdk context")
}
const failAwayStack=new AZFailAwayStack(app, 'AzFailAwayStack', {
    env: env,
    tracing: Tracing.ACTIVE,
    lookupASGsThatPreviouslyUsedThisAz:{
        timeout: Duration.seconds(30),
        memorySize: 256

    },
    findAllASGsThatUseThisAzProps:{
        timeout: Duration.seconds(30),
        memorySize: 256

    }
});
cdk.Aspects.of(failAwayStack).add(new AwsSolutionsChecks())
NagSuppressions.addStackSuppressions(failAwayStack,[{
    id: "AwsSolutions-IAM4",
    reason: "Ok to use AWS managed policies",

},
    {
        id: "AwsSolutions-APIG4",
        reason: "Customer should implement authorization as they see fit"
    }],true)
new TestAsgStack(app,"TestAsgStack",{
    env:env,
    count: 3,
    vpcId: app.node.tryGetContext("vpcId"),
    cellular:false
})
new Route53ArcStack(app,"RecoveryGroup000Stack",{
    region:env.region,
    recoveryGroupTagValue:"RecoveryGroup000",
    regionalCellTagValue: "RegionalCell000",
    env:{
        region:"us-east-1"
    }
})