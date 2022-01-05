# az-fail-away

This project provides a serverless infrastructure for updating the availability zones of autoscaling groups en masse.

## Architecture

![](./images/architecture.drawio.png)

## Useful commands

 * `npm run build`   compile typescript to js
 * `cdk deploy -c account=<your_account> -c region=<your_region> AzFailAwayStack`
 * `cdk deploy -c account=<your_account> -c region=<your_region> -c vpcId <your_vpc_id> TestAsgStack`
