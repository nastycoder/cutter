// Low-level DynamoDB single-table access.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.TABLE_NAME!;

export const gpk = (gid: string) => `GUILD#${gid}`;

export async function getItem<T>(pk: string, sk: string): Promise<T | undefined> {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
  return r.Item as T | undefined;
}

export async function putItem(item: Record<string, unknown>): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
}

export async function queryPrefix<T>(pk: string, skPrefix: string): Promise<T[]> {
  const r = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
    })
  );
  return (r.Items ?? []) as T[];
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
}

export async function queryGSI1<T>(gsi1pk: string): Promise<T[]> {
  const r = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": gsi1pk },
    })
  );
  return (r.Items ?? []) as T[];
}
