import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { readFileSync } from 'fs';

export interface ExtendedStackProps extends cdk.StackProps {
  readonly keyPairName: string,
  readonly dbUsername: string,
  readonly dbPort: number,
  readonly orgName: string,
  readonly repoName: string,
}

const createVpc = (construct: Construct): ec2.Vpc => {
  const vpc = new ec2.Vpc(construct, `tpb-vpc`, {
    ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/24'),
    natGateways: 1,
    subnetConfiguration: [
      {
        name: `tpb-public-subnet-1`,
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 28,
      },
      // {
      //   name: `tpb-isolated-subnet-1`,
      //   subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      //   cidrMask: 28,
      // }
    ]
  });
  return vpc;
}

const createEC2Instance = (scope: Construct, vpc: ec2.Vpc, keyPairName: string): ec2.Instance => {
  const ec2SG = new ec2.SecurityGroup(scope, 'ec2-sec-group', {
    vpc: vpc,
    securityGroupName: `tpb-ec2-security-group`
  });

  ec2SG.addIngressRule(
    ec2.Peer.anyIpv4(),
    ec2.Port.tcp(22),
    'Allow SSH Connections.'
  );

  ec2SG.addIngressRule(
    ec2.Peer.anyIpv4(),
    ec2.Port.tcp(5000),
    'Allow API Requests.'
  );

  const keyPair = ec2.KeyPair.fromKeyPairName(scope, 'key-pair', keyPairName);

  const ec2IAMRole = new iam.Role(scope, 'ec2-role', {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    roleName: `tpb-ec2-role`,
  });

  ec2IAMRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'ssm:GetParameter'],
    resources: ['*'],
  }));

  const ec2Instance = new ec2.Instance(scope, 'ec2-instance', {
    instanceName: `tpb-ec2-instance`,
    vpc: vpc,
    vpcSubnets: {
      subnetType: ec2.SubnetType.PUBLIC,
    },
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MICRO),
    keyPair: keyPair,
    machineImage: new ec2.AmazonLinuxImage({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
    }),
    securityGroup: ec2SG,
    role: ec2IAMRole,
  });

  const eip = new ec2.CfnEIP(scope, 'tpb-eip');
  const eipAssoc = new ec2.CfnEIPAssociation(scope, 'tpb-eip-assoc', {
    allocationId: eip.attrAllocationId,
    instanceId: ec2Instance.instanceId,
  });

  // TODO : add this when creating user data script for EC2.
  // const userDataScript = readFileSync('./lib/user-data.sh', 'utf8');
  // ec2Instance.addUserData(userDataScript);

  return ec2Instance;
}

const createDBInstance = (scope: Construct, vpc: ec2.Vpc, dbUsername: string, port: number): rds.DatabaseInstance => {
  const dbSG = new ec2.SecurityGroup(scope, 'db-sec-group', {
    vpc: vpc,
    securityGroupName: `tpb-db-security-group`
  });

  dbSG.addIngressRule(
    ec2.Peer.anyIpv4(),
    ec2.Port.tcp(port),
    'Allow MSSQL Connections.'
  );

  const dbInstance = new rds.DatabaseInstance(scope, `tpb-db`, {
    vpc: vpc,
    vpcSubnets: {
      subnetType: ec2.SubnetType.PUBLIC,
    },
    engine: rds.DatabaseInstanceEngine.sqlServerEx({
      version: rds.SqlServerEngineVersion.VER_16,
    }),
    instanceType: ec2.InstanceType.of(
      ec2.InstanceClass.BURSTABLE3,
      ec2.InstanceSize.MICRO,
    ),
    credentials: rds.Credentials.fromGeneratedSecret(dbUsername, {
      secretName: `tpb-rds-credentials`
    }),
    multiAz: false,
    allocatedStorage: 20,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    securityGroups: [dbSG],
    instanceIdentifier: `tpb-db`,
  });

  return dbInstance;
}

const createS3Bucket = (scope: Construct) => {
  const tpbBucket = new s3.Bucket(scope, 'TpbBucket', {
    accessControl: s3.BucketAccessControl.PRIVATE,
  })

 return tpbBucket;
}

const initializeOidcProvider = (scope: Construct, githubOrganisation: string, repoName: string, accountNumber: string) => {
  const provider = new iam.OpenIdConnectProvider(scope, 'MyProvider', {
  url: 'https://token.actions.githubusercontent.com',
  clientIds: ['sts.amazonaws.com'],
  });

  const GitHubPrincipal = new iam.OpenIdConnectPrincipal(provider).withConditions(
    {
      StringLike: {
        'token.actions.githubusercontent.com:sub':
          `repo:${githubOrganisation}/${repoName}:*`,
      },
    }
  );

  new iam.Role(scope, 'GitHubActionsRole', {
    assumedBy: GitHubPrincipal,
    description:
      'Role assumed by GitHub actions for CD Runners.',
    roleName: 'github-actions-role',
    maxSessionDuration: cdk.Duration.hours(1),
    inlinePolicies: {
      CdkDeploymentPolicy: new iam.PolicyDocument({
        assignSids: true,
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${accountNumber}:role/cdk-*`],
          }),
        ],
      }),
    },
  });
}

export class TaskProgressInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExtendedStackProps) {
    super(scope, id, props);
    
    const vpc = createVpc(this);
    const ec2Instance = createEC2Instance(this, vpc, props.keyPairName);
    const s3Bucket = createS3Bucket(this);
    const db = createDBInstance(this, vpc, props.dbUsername, props.dbPort);
    initializeOidcProvider(this, props.orgName, props.repoName, this.account);

    db.connections.allowFrom(ec2Instance, ec2.Port.tcp(props.dbPort));
  }
}
