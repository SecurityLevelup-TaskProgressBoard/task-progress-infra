#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TaskProgressInfraStack } from '../lib/task-progress-infra-stack';

const app = new cdk.App();
new TaskProgressInfraStack(app, 'TaskProgressInfraStack', {
  keyPairName: 'tpb-key',
  dbPort: 17388,
  dbUsername: 'tpb_db_user'
});