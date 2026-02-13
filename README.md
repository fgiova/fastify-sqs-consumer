# fastify sqs-consumer
[![NPM version](https://img.shields.io/npm/v/@fgiova/fastify-sqs-consumer.svg?style=flat)](https://www.npmjs.com/package/@fgiova/fastify-sqs-consumer)
![CI workflow](https://github.com/fgiova/fastify-sqs-consumer/actions/workflows/node.js.yml/badge.svg)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)
[![Linted with Biome](https://img.shields.io/badge/Linted_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)
[![Maintainability](https://qlty.sh/gh/fgiova/projects/fastify-sqs-consumer/maintainability.svg)](https://qlty.sh/gh/fgiova/projects/fastify-sqs-consumer)
[![Code Coverage](https://qlty.sh/gh/fgiova/projects/fastify-sqs-consumer/coverage.svg)](https://qlty.sh/gh/fgiova/projects/fastify-sqs-consumer)

## Description
This plugin for fastify 5.x (for fastify 4.x use 1.x ver) allows you to consume messages from AWS SQS queues.
On fastify shutdown a simple wait function is called to wait for the end of the processing of the messages in progress.

**Warning**<br>
To use this plugin, you must have correctly configured your [AWS credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).<br>
This plugin uses [@fgiova/mini-sqs-client](https://www.npmjs.com/package/@fgiova/mini-sqs-client) and [@fgiova/sqs-consumer](https://www.npmjs.com/package/@fgiova/sqs-consumer) to interact with SQS service.

## Install
```bash
npm i @fgiova/fastify-sqs-consumer
```

## Usage

### ESM
```js
import fastify from "fastify";
import sqsConsumer from "@fgiova/fastify-sqs-consumer";

const app = fastify();

app.register(sqsConsumer, [
    {
        arn: "arn:aws:sqs:eu-central-1:000000000000:MyQueue",
        waitTimeSeconds: 20,
        timeout: 10_000,
        batchSize: 10,
        handlerFunction: async (message, fastify) => {
            return true;
        }
    }
]);
```

### CommonJS
```js
const fastify = require("fastify")();

fastify.register(require("@fgiova/fastify-sqs-consumer").default, [
    {
        arn: "arn:aws:sqs:eu-central-1:000000000000:MyQueue",
        waitTimeSeconds: 20,
        timeout: 10_000,
        batchSize: 10,
        handlerFunction: async (message, fastify) => {
            return true;
        }
    }
]);
```

## Options
Options are an array of objects with the following properties (one for each queue):

| Option                | Type                                | Description                                                                                                                                                                                                                                                                                                           |
|-----------------------|-------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| arn*                  | string                              | The ARN of the Amazon SQS queue from which messages are received.                                                                                                                                                                                                                                                     |
| handlerFunction*      | function                            | The function that will be called for each message.                                                                                                                                                                                                                                                                    |
| name                  | string                              | An optional name for the consumer (useful for add [hooks](https://github.com/fgiova/sqs-consumer?tab=readme-ov-file#hooks) post config). If not provided, uuid is assigned.                                                                                                                                           |
| waitTimeSeconds       | number                              | The duration (in seconds, default 20s) for which the call waits for a message to arrive in the queue before returning. If a message is available, the call returns sooner than WaitTimeSeconds. If no messages are available and the wait time expires, the call returns successfully with an empty list of messages. |
| timeout               | number                              | The duration before the message is considered as failed: default 90000ms.                                                                                                                                                                                                                                             |
| batchSize             | number                              | The maximum number of messages to return. Amazon SQS never returns more messages than this value (however, fewer messages might be returned). Valid values: 1 to 10. Default: 1.                                                                                                                                      |
| attributeNames        | string[]                            | Array of message system attributes to retrieve for each message.                                                                                                                                                                                                                                                      |
| messageAttributeNames | string[]                            | Array of custom message attributes to retrieve for each message.                                                                                                                                                                                                                                                      |
| parallelExecution     | boolean                             | Enable parallel execution of message handlers.                                                                                                                                                                                                                                                                        |
| credentials           | {accessKeyId, secretAccessKey}      | Explicit AWS credentials (alternative to environment configuration).                                                                                                                                                                                                                                                  |
| events                | object                              | Events functions for the consumer (detail in next table).                                                                                                                                                                                                                                                             |
| sqs                   | MiniSQSClient                       | Initialized [@fgiova/mini-sqs-client](https://www.npmjs.com/package/@fgiova/mini-sqs-client) instance (useful for testing sessions).                                                                                                                                                                                  |

\* required

## Decorator

The plugin decorates the Fastify instance with `sqsConsumers`, a `Record<string, { consumer: SQSConsumer, meta: { pendingMessages: number } }>` that provides access to the registered consumers and their metadata.

## handlerFunction

Handler function is an async function called for each message received from the queue.
Each Error thrown by the function is caught and the message is not deleted from the queue.
Otherwise, the message is deleted from the queue.

### Events

| Option           | Type                                                                  | Description                                                         |
|------------------|-----------------------------------------------------------------------|---------------------------------------------------------------------|
| onPoll           | (messages: Message[]) => Promise<Message[]>                           | Called when the consumer polls for messages                         |
| onMessage        | (message: Message) => Promise<Message>                                | Called when the consumer receives a message                         |
| onHandle         | (message: Message) => Promise<Message>                                | Called when the consumer handles a message                          |
| onHandlerSuccess | (message: Message) => Promise<Message>                                | Called when the consumer handles a message successfully             |
| onHandlerTimeout | (message: Message) => Promise<Message>                                | Called when the consumer handler execution exceed executionTimeout  |
| onHandlerError   | (message: Message, error: Error) => Promise<Boolean>                  | Called when the consumer handler execution throws an error          |
| onSuccess        | (message: Message) => Promise<Message>                                | Called when the consumer handler execution finishes successfully    |
| onError          | ( hook: HookName, message: Message, error: Error) => Promise<Boolean> | Called when the consumer handler execution throws an uncaught error |
| onSQSError       | (error: Error, message?: Message) => Promise<void>                    | Called when the consumer receives an error from the SQS service     |

## License
Licensed under [MIT](./LICENSE).