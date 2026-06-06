import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as path from "path";

export class CutterStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- single-table store ----
    const table = new dynamodb.Table(this, "Table", {
      tableName: "Cutter",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });

    // ---- Discord credentials (publicKey / appId / botToken) ----
    const secret = new secretsmanager.Secret(this, "DiscordSecret", {
      secretName: "cutter/discord",
      description: "Discord app credentials: { publicKey, appId, botToken }",
    });

    // ---- interactions Lambda ----
    const logGroup = new logs.LogGroup(this, "InteractionsLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "Interactions", {
      entry: path.join(__dirname, "../../bot/src/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup,
      environment: {
        TABLE_NAME: table.tableName,
        DISCORD_SECRET_ARN: secret.secretArn,
      },
      bundling: { minify: true, target: "node20", sourceMap: true },
    });
    table.grantReadWriteData(fn);
    secret.grantRead(fn);
    fn.grantInvoke(fn); // self-invoke for deferred (async) command handling

    // ---- HTTP API: POST /interactions ----
    const api = new apigw.HttpApi(this, "Api", { apiName: "cutter" });
    api.addRoutes({
      path: "/interactions",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("Integration", fn),
    });

    new CfnOutput(this, "InteractionsUrl", {
      value: `${api.apiEndpoint}/interactions`,
    });
    new CfnOutput(this, "SecretName", { value: secret.secretName });
  }
}
