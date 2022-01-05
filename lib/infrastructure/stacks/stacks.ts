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
import {Duration, Lazy, NestedStack, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {AZTable} from "../constructs/database";
import {Api} from "../constructs/api";
import {AZFailAwayStateMachine, AZFailAwayStateMachineProps, LambdaProps} from "../constructs/stateMachine";
import {Tracing} from "aws-cdk-lib/aws-lambda";
import {AutoScalingGroup, CfnAutoScalingGroup, Signals, UpdatePolicy} from "aws-cdk-lib/aws-autoscaling";
import {
    AmazonLinuxCpuType,
    AmazonLinuxGeneration,
    AmazonLinuxImage,
    AmazonLinuxStorage,
    CloudFormationInit,
    InitCommand,
    InitFile, InitService, InitServiceRestartHandle,
    InstanceClass,
    InstanceSize,
    InstanceType,
    Peer,
    Port,
    SecurityGroup,
    SubnetType, UserData,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ApplicationTargetGroup,
    IpAddressType,
    ListenerCondition,
    Protocol,
    TargetGroupLoadBalancingAlgorithmType,
    TargetType
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {dedent} from "ts-dedent"
import {ManagedPolicy, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";

export interface StatelessStackProps extends AZFailAwayStateMachineProps {

}

export interface TestAsgStackProps extends StackProps {
    vpcId: string,
    count: number
}

export class TestAsgStack extends Stack {
    get notificationArns(): string[] {
        return super.notificationArns;
    }
    constructor(scope: Construct, id: string, props: TestAsgStackProps) {
        super(scope, id, props);
        const vpc = Vpc.fromLookup(this, "test-asg-vpc", {
            vpcId: props.vpcId
        })
        const albSecurityGroup = new SecurityGroup(this, 'alb-security-group', {vpc});
        albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), "Allow http traffic")
        const webServerSecurityGroup = new SecurityGroup(this, 'web-server-security-group', {vpc});
        webServerSecurityGroup.addIngressRule(webServerSecurityGroup, Port.tcp(3000), "Connect to express server")
        const script = dedent`
        const express = require('express')
        const http = require('http')
        const app = express()
        const port = 3000
        
        app.get('/', (req, res) => {
            var options = {
              host: '169.254.169.254',
              path: '/latest/meta-data/instance-id'
            };
            
          
            http.request({
              host: '169.254.169.254',
              path: '/latest/meta-data/instance-id'
            }, (r01) => {
              var instanceId = '';
            
              //another chunk of data has been received, so append it to \`str\`
              r01.on('data', function (chunk) {
                instanceId += chunk;
              });
            
              //the whole response has been received, so we just print it out here
              r01.on('end', function () {
                http.request({
                  host: '169.254.169.254',
                  path: '/latest/meta-data/placement/availability-zone-id'
                }, (r02) => {
                  var zoneId = '';
                
                  //another chunk of data has been received, so append it to \`str\`
                  r02.on('data', function (chunk) {
                    zoneId += chunk;
                  });
                
                  //the whole response has been received, so we just print it out here
                  r02.on('end', function () {
                    res.send("Hello World! "+instanceId+" : "+zoneId)
                  });
                }).end()
                
              });
            }).end()
        })
        
        app.listen(port,'0.0.0.0', () => {
          console.log(\`Example app listening at http://0.0.0.0:\${port}\`)
        })
        `
        const nodeService = dedent`
            [Unit]
            Description=server.js 
            After=network.target
            
            [Service]
            Type=simple
            User=root
            ExecStart=/usr/bin/node /root/server.js
            Restart=on-failure
            WorkingDirectory=/root
            
            [Install]
            WantedBy=multi-user.target
        `
        const cfnInit = CloudFormationInit.fromElements(
            InitCommand.shellCommand("yum update -y"),
            InitCommand.shellCommand("curl -sL https://rpm.nodesource.com/setup_lts.x | bash -"),
            InitCommand.shellCommand("yum install -y nodejs"),
            InitCommand.shellCommand("node -e \"console.log('Running Node.js ' + process.version)\""),
            InitCommand.shellCommand("npm install express", {
                cwd: "/root"
            }),
            InitCommand.shellCommand("npm install express", {
                cwd: "/root"
            }),

            InitFile.fromString("/root/server.js", script),
            InitFile.fromString("/etc/systemd/system/node.service",nodeService),
            InitService.enable("node",{
                enabled: true,
                ensureRunning: true
            })

        )

        const instanceRole=new Role(this,"instance-role",{
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromManagedPolicyArn(this,"AmazonSSMManagedInstanceCore","arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"),
                ManagedPolicy.fromManagedPolicyArn(this,"CloudWatchAgentServerPolicy","arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy")
            ]
        })
        Array(props.count).fill(0).map((_, i) => {

            const privateSubnets = vpc.selectSubnets({
                onePerAz: true,
                subnetType: SubnetType.PRIVATE_ISOLATED
            })
            const publicSubnets = vpc.selectSubnets({
                onePerAz: true,
                subnetType: SubnetType.PUBLIC
            })


            const asg = new AutoScalingGroup(this, `asg-${i}`, {
                vpc,
                instanceType: InstanceType.of(InstanceClass.BURSTABLE3, InstanceSize.MICRO),
                machineImage: new AmazonLinuxImage({
                    generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
                    cpuType: AmazonLinuxCpuType.X86_64,
                    storage: AmazonLinuxStorage.EBS
                }),
                role: instanceRole,
                userData: UserData.forLinux(),
                init: cfnInit,
                initOptions: {
                    ignoreFailures: true,
                    printLog: true
                },
                signals: Signals.waitForMinCapacity(),
                securityGroup: webServerSecurityGroup,
                vpcSubnets: privateSubnets,

                maxCapacity: 10,
                minCapacity: 3,
                desiredCapacity: 3,
                updatePolicy: UpdatePolicy.replacingUpdate()

            })
            const cfnLaunchConfig=asg.node.defaultChild as CfnAutoScalingGroup

            asg.userData.addCommands(`/opt/aws/bin/cfn-signal -e $? --stack ${this.stackName} --resource ${this.getLogicalId(cfnLaunchConfig)} --region ${this.region} `.trim())
            const alb = new ApplicationLoadBalancer(this, `alb-${i}`, {
                vpc: vpc,
                securityGroup: albSecurityGroup,
                vpcSubnets: publicSubnets,
                loadBalancerName: `alb-${i}`,
                ipAddressType: IpAddressType.IPV4,
                internetFacing: true
            })
            alb.addSecurityGroup(webServerSecurityGroup)
            const atg = new ApplicationTargetGroup(this, `tg-${i}`, {
                vpc: vpc,
                port: 3000,
                healthCheck: {
                    enabled: true,
                    port: "3000",
                    path: "/",
                    protocol: Protocol.HTTP,
                    healthyThresholdCount: 2,
                    interval: Duration.seconds(10),
                    timeout: Duration.seconds(5),
                    unhealthyThresholdCount: 3

                },

                protocol: ApplicationProtocol.HTTP,
                targetType: TargetType.INSTANCE,
                targetGroupName: `tg-${i}`,
                loadBalancingAlgorithmType: TargetGroupLoadBalancingAlgorithmType.ROUND_ROBIN,
                slowStart: Duration.seconds(180)

            })
            atg.addTarget(asg)
            const listener = alb.addListener("http-listener", {
                port: 80,
                protocol: ApplicationProtocol.HTTP,
                defaultTargetGroups: [atg]

            })
            listener.addTargetGroups("/", {
                conditions: [ListenerCondition.pathPatterns(["/"])],
                targetGroups: [atg],
                priority: 1
            })

        })

    }
}

export interface AZFailAwayStackProps extends StackProps {
    tracing: Tracing
    findAllASGsThatUseThisAzProps: LambdaProps
    lookupASGsThatPreviouslyUsedThisAz: LambdaProps

}

export class AZFailAwayStack extends Stack {
    constructor(scope: Construct, id: string, props: AZFailAwayStackProps) {
        super(scope, id, props);
        const statefulStack = new StatefulStack(this, "stateful")
        const statelessStack = new StatelessStack(this, "stateless", {
            azTable: statefulStack.azTable,
            tracing: props.tracing,
            findAllASGsThatUseThisAzProps: props.findAllASGsThatUseThisAzProps,
            lookupASGsThatPreviouslyUsedThisAz: props.lookupASGsThatPreviouslyUsedThisAz
        })
    }
}

class StatefulStack extends NestedStack {
    readonly azTable: AZTable

    constructor(scope: Construct, id: string) {
        super(scope, id);
        this.azTable = new AZTable(this, "az-table")

    }
}

class StatelessStack extends NestedStack {
    readonly api: Api
    readonly stateMachine: AZFailAwayStateMachine

    constructor(scope: Construct, id: string, props: StatelessStackProps) {
        super(scope, id);
        this.stateMachine = new AZFailAwayStateMachine(this, "az-fail-away-state-machine", props)
        this.api = new Api(this, "az-fail-away-api", {
            stateMachine: this.stateMachine
        })
    }
}