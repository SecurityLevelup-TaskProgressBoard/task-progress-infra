import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { CacheCookieBehavior, CacheHeaderBehavior, CachePolicy, CacheQueryStringBehavior, Distribution, OriginAccessIdentity, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { readFileSync } from 'fs';

export interface ExtendedStackProps extends cdk.StackProps {
  readonly keyPairName: string,
  readonly dbUsername: string,
  readonly dbPort: number,
  readonly orgName: string,
  readonly repoName: string,
  readonly domainNames: string[],
  readonly certificateArn: string,
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
    ec2.Port.tcp(5000), //TODO add api port
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

  // const userDataScript = readFileSync('./user-data.sh', 'utf8');
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

  const dbInstance = new rds.DatabaseInstance(scope, `tpb-rds`, {
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
    port: port
  });

  return dbInstance;
}

const createS3Bucket = (scope: Construct) => {
  const tpbBucket = new s3.Bucket(scope, 'TpbBucket', {
    accessControl: s3.BucketAccessControl.PRIVATE,
    bucketName: 'tpb-web-bucket'
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
          `repo:${githubOrganisation}/*`,
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
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:PutObject'],
            resources: [`arn:aws:s3:::tpb-web-bucket/*`],
          }),
        ],
      }),
    },
  });
}

const initializeCloudFrontDistribution = (scope: Construct, bucket: s3.Bucket, domainNames: string[], certArn: string) => {
  const originAccessIdentity = new OriginAccessIdentity(scope, 'OriginAccessIdentity');
  bucket.grantRead(originAccessIdentity);

  const cachePolicy = new CachePolicy(scope, 'CachePolicy', {
    cachePolicyName: 'tpbCachePolicy',
    comment: 'Custom cache policy for TPB CloudFront distribution',
    defaultTtl: cdk.Duration.minutes(10),
    minTtl: cdk.Duration.minutes(10),
    maxTtl: cdk.Duration.minutes(30),
    cookieBehavior: CacheCookieBehavior.none(),
    headerBehavior: CacheHeaderBehavior.none(),
    queryStringBehavior: CacheQueryStringBehavior.none()
  });

  new Distribution(scope, 'Distribution', {
    domainNames: domainNames,
    certificate: Certificate.fromCertificateArn(scope, 'webCert', certArn),
    defaultRootObject: 'index.html',
    defaultBehavior: {
      origin: new S3Origin(bucket, { originAccessIdentity }),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cachePolicy
    },
  });
}

const initializeCognito = (scope: Construct) => {
  const tpbUserPool = new cognito.UserPool(scope, 'tpbUserPool', {
    userPoolName: 'tpbUserPool',
    selfSignUpEnabled: true,
    signInAliases: {
      email: true,
    },
    autoVerify: {
      email: true,
    },
    standardAttributes: {
      givenName: {
        required: true,
        mutable: true,
      },
      familyName: {
        required: true,
        mutable: true,
      }
    },
    passwordPolicy: {
      minLength: 8,
      requireLowercase: true,
      requireDigits: true,
      requireUppercase: false,
      requireSymbols: false,
    },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const standardCognitoAttributes = {
    givenName: true,
    familyName: true,
    email: true,
    emailVerified: true,
    address: true,
    birthdate: true,
    gender: true,
    phoneNumber: true,
    phoneNumberVerified: true,
    profilePicture: true,
    preferredUsername: true,
    timezone: true,
    lastUpdateTime: true,
  };

  const clientReadAttributes = new cognito.ClientAttributes().withStandardAttributes(standardCognitoAttributes);
  const clientWriteAttributes = new cognito.ClientAttributes().withStandardAttributes(
    {
      ...standardCognitoAttributes,
      emailVerified: false,
      phoneNumberVerified: false
    }
  );

  const userPoolClient = new cognito.UserPoolClient(scope, 'tpbUserPoolClient', {
    userPool: tpbUserPool,
    authFlows: {
      custom: true,
      userSrp: true
    },
    supportedIdentityProviders: [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ],
    readAttributes: clientReadAttributes,
    writeAttributes: clientWriteAttributes,
  });
}

export class TaskProgressInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExtendedStackProps) {
    super(scope, id, props);

    const vpc = createVpc(this);

    const ec2Instance = createEC2Instance(this, vpc, props.keyPairName);

    const s3Bucket = createS3Bucket(this);

    const db = createDBInstance(this, vpc, props.dbUsername, props.dbPort);
    db.connections.allowFrom(ec2Instance, ec2.Port.tcp(props.dbPort));

    initializeOidcProvider(this, props.orgName, props.repoName, this.account);

    initializeCloudFrontDistribution(this, s3Bucket, props.domainNames, props.certificateArn);

    initializeCognito(this);
  }
}
