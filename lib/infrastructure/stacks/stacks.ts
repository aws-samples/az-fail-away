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
import {Duration, Lazy, NestedStack, Stack, StackProps, Tags} from 'aws-cdk-lib';
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
    InstanceType, IVpc,
    Peer,
    Port,
    SecurityGroup, SubnetSelection,
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
import {CfnCell, CfnRecoveryGroup, CfnResourceSet} from "aws-cdk-lib/aws-route53recoveryreadiness";
import {
    GetResourcesCommand,
    paginateGetResources,
    ResourceGroupsTaggingAPIClient
} from "@aws-sdk/client-resource-groups-tagging-api";
import {AutoScalingClient, paginateDescribeAutoScalingGroups} from "@aws-sdk/client-auto-scaling";

export interface StatelessStackProps extends AZFailAwayStateMachineProps {

}

export interface TestAsgStackProps extends StackProps {
    vpcId: string,
    count: number
    cellular: boolean
}

const ROUTE_53_RECOVERY_READINESS_CFN_SUPPORTED_REGIONS = ["us-east-1", "us-west-2"]

export interface Route53ArcStackProps extends StackProps {
    recoveryGroupTagValue: string
    regionalCellTagValue: string
    region: string
}

export class Route53ArcStack extends Stack {
    constructor(scope: Construct, id: string, props: Route53ArcStackProps) {
        super(scope, id, props);
        if (ROUTE_53_RECOVERY_READINESS_CFN_SUPPORTED_REGIONS.indexOf(this.region) == -1) {
            throw new Error(`Route 53 Arc only supported in ${ROUTE_53_RECOVERY_READINESS_CFN_SUPPORTED_REGIONS}`)
        }

        const recoveryGroup = new CfnRecoveryGroup(this, "RecoveryGroup", {
            recoveryGroupName: props.recoveryGroupTagValue,
            cells: []
        })

        const regionalCell = new CfnCell(this, "RegionalCell", {
            cellName: props.regionalCellTagValue,
            cells: []
        })
        recoveryGroup.cells?.push(regionalCell.attrCellArn)

        const regionalCellResources = (async (): Promise<string[]> => {
            let results: string[] = []
            const client = new ResourceGroupsTaggingAPIClient({region: props.region});
            const regionalCellResourcePaginator = paginateGetResources({
                client: client,
                pageSize: 100,
            }, {
                TagFilters: [{
                    Key: "Cell",
                    Values: [props.regionalCellTagValue],

                }, {
                    Key: "CellType",
                    Values: ["Regional"],

                }, {
                    Key: "RecoveryGroup",
                    Values: [props.recoveryGroupTagValue],

                }],
                ResourceTypeFilters: ["elasticloadbalancing:loadbalancer"]
            });
            for await (const page of regionalCellResourcePaginator) {
                if (page.ResourceTagMappingList != null) {
                    results = results.concat(page.ResourceTagMappingList.flatMap(value => {

                        return value.ResourceARN!
                    }))

                }
            }
            return results
        })()
        regionalCellResources.then(value => {
            new CfnResourceSet(this, `${regionalCell.cellName}-resource-set`, {
                resourceSetName: `${regionalCell.cellName}-resource-set`,
                resourceSetType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
                resources: value.map(value1 => {
                    return {
                        readinessScopes: [regionalCell.attrCellArn],
                        resourceArn: value1
                    }
                })
            })
        })
        const zonalCellResources = (async (): Promise<Map<string,string[]>> => {
            const accumulator:Map<string,string[]>=new Map<string, string[]>()
            const client = new AutoScalingClient({region: props.region})
            const zonalCellResourcePaginator = paginateDescribeAutoScalingGroups({
                pageSize: 100,
                client: client,
            }, {
                Filters: [{
                    Name: "tag:CellType",
                    Values: ["Zonal"],

                }, {
                    Name: "tag:RecoveryGroup",
                    Values: [props.recoveryGroupTagValue],

                }, {
                    Name: "tag:RegionalCell",
                    Values: [props.regionalCellTagValue],

                }]
            })

            for await (const page of zonalCellResourcePaginator) {
                if (page.AutoScalingGroups != null) {

                    page.AutoScalingGroups.map(value => {
                        const cellValue = value.Tags?.find(tag => tag.Key = "Cell")?.Value

                        return new Map<string, string>([
                            [ cellValue != null ? cellValue : "N/A",value.AutoScalingGroupARN!],

                        ]) as Map<string, string>

                    }).forEach(currentValue => {
                        for (const key of currentValue.keys()){
                            const value = currentValue.get(key)
                            if(value!=null && value!="N/A") {
                                if (accumulator.has(key)) {
                                    if (Array.isArray(accumulator.get(key))) {
                                        (accumulator.get(key) as string[]).push(value)
                                    }
                                }else{
                                    accumulator.set(key,[value])
                                }
                            }

                        }
                    })



                }
            }
            return accumulator
        })()
        zonalCellResources.then(value => {
            for(const key of value.keys()) {
                const resources=value.get(key)!
                console.log(`ZonalCell ${key}: ${resources}`)
                const zonalCell=new CfnCell(this,`${key}`,{
                    cells:[],
                    cellName:key

                })
                regionalCell.cells?.push(zonalCell.attrCellArn)
                new CfnResourceSet(this, `${key}-resource-set`, {
                    resourceSetName: `${zonalCell.cellName}-resource-set`,
                    resourceSetType: "AWS::AutoScaling::AutoScalingGroup",
                    resources: resources.map(value1 => {
                        return {
                            readinessScopes: [zonalCell.attrCellArn],
                            resourceArn: value1
                        }
                    })
                })
            }
        })
    }
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
            InitFile.fromString("/etc/systemd/system/node.service", nodeService),
            InitService.enable("node", {
                enabled: true,
                ensureRunning: true
            })
        )

        const instanceRole = new Role(this, "instance-role", {
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromManagedPolicyArn(this, "AmazonSSMManagedInstanceCore", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"),
                ManagedPolicy.fromManagedPolicyArn(this, "CloudWatchAgentServerPolicy", "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy")
            ]
        })
        Array(props.count).fill(0).map((_, i) => {

            const privateSubnets = vpc.selectSubnets({
                onePerAz: true,
                subnetType: SubnetType.PRIVATE_ISOLATED
            })
            const publicSubnets = vpc.selectSubnets({
                onePerAz: true,
                subnetType: SubnetType.PUBLIC,

            })
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
            const number = i.toString().padStart(3, "0")
            const recoveryGroupName = `RecoveryGroup${number}`
            const regionalCellName = `RegionalCell${number}`

            Tags.of(alb).add("RecoveryGroup", recoveryGroupName)
            Tags.of(alb).add("CellType", "Regional")
            Tags.of(alb).add("Cell", regionalCellName)

            if (props.cellular) {
                privateSubnets.subnets.forEach((subnet, index) => {
                    const letter = subnet.availabilityZone.charAt(subnet.availabilityZone.length - 1)
                    const zonalCellName = `Cell${number}${letter}`

                    const subnetSelection = vpc.selectSubnets({
                        subnets: [subnet]
                    })
                    const asg = this.createAsg(i, letter, vpc, instanceRole, cfnInit, webServerSecurityGroup, subnetSelection)
                    atg.addTarget(asg)
                    Tags.of(asg).add("RecoveryGroup", recoveryGroupName)
                    Tags.of(asg).add("RegionalCell", regionalCellName)
                    Tags.of(asg).add("CellType", "Zonal")
                    Tags.of(asg).add("Cell", zonalCellName)

                })
            } else {
                const letter = ""
                const zonalCellName = `Cell${number}${letter}`
                const asg = this.createAsg(i, letter, vpc, instanceRole, cfnInit, webServerSecurityGroup, privateSubnets)
                atg.addTarget(asg)
                Tags.of(asg).add("RecoveryGroup", recoveryGroupName)
                Tags.of(asg).add("RegionalCell", regionalCellName)
                Tags.of(asg).add("CellType", "Zonal")
                Tags.of(asg).add("Cell", zonalCellName)
            }
        })

    }

    private createAsg(i: number, letter: string, vpc: IVpc, instanceRole: Role, cfnInit: CloudFormationInit, webServerSecurityGroup: SecurityGroup, vpcSubnets: SubnetSelection): AutoScalingGroup {

        const asg = new AutoScalingGroup(this, `asg-${i}${letter}`, {
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
            vpcSubnets: vpcSubnets,
            maxCapacity: 10,
            minCapacity: 3,
            desiredCapacity: 3,
            updatePolicy: UpdatePolicy.replacingUpdate()

        })

        const cfnLaunchConfig = asg.node.defaultChild as CfnAutoScalingGroup
        asg.userData.addCommands(`/opt/aws/bin/cfn-signal -e $? --stack ${this.stackName} --resource ${this.getLogicalId(cfnLaunchConfig)} --region ${this.region} `.trim())
        return asg

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