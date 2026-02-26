import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

const smClient = new SecretsManagerClient({});
const secretArn = process.env.DB_SECRET_ARN!;
const writerEndpoint = process.env.DB_WRITER_ENDPOINT!;
const readerEndpoint = process.env.DB_READER_ENDPOINT!;

let writerPool: Pool | null = null;
let readerPool: Pool | null = null;

async function getDbCredentials() {
  const data = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!data.SecretString) {
    throw new Error('Database secret not found');
  }
  return JSON.parse(data.SecretString);
}

export async function getWriterPool(): Promise<Pool> {
  if (!writerPool) {
    const creds = await getDbCredentials();
    writerPool = new Pool({
      host: writerEndpoint,
      port: creds.port,
      user: creds.username,
      password: creds.password,
      database: creds.dbname,
      max: 10,
    });
  }
  return writerPool;
}

export async function getReaderPool(): Promise<Pool> {
  if (!readerPool) {
    const creds = await getDbCredentials();
    readerPool = new Pool({
      host: readerEndpoint,
      port: creds.port,
      user: creds.username,
      password: creds.password,
      database: creds.dbname,
      max: 10,
    });
  }
  return readerPool;
}
