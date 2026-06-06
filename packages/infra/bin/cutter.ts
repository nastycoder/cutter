#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { CutterStack } from "../lib/cutter-stack";

const app = new App();
new CutterStack(app, "CutterStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
