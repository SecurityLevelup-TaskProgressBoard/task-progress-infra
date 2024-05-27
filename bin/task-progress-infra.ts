#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TaskProgressInfraStack } from '../lib/task-progress-infra-stack';

const app = new cdk.App();
new TaskProgressInfraStack(app, 'TaskProgressInfraStack', {
  keyPairName: 'tpb-key',
  dbPort: 17388,
  dbUsername: 'tpb_db_user',
  orgName: 'SecurityLevelup-TaskProgressBoard',
  repoName: 'task-progress-infra',
  domainNames: ['tpb.phipson.co.za'],
  certificateArn: 'arn:aws:acm:us-east-1:978251882572:certificate/04effc3d-d3be-486a-9f2a-e3576a329323',
});