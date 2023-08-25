import { test, end } from "tap";
import "../helpers/localtest";
import Fastify from "fastify";
import fp from "fastify-plugin";
// @ts-ignore
import sqsPlugin from "../../src";
import { setTimeout } from "timers/promises";
import { getSqsAttributes, sendSQS, sqsPurge } from "../helpers/sqsMessage";
import {Message, SQSClient} from "@aws-sdk/client-sqs";

test("sqs", { timeout: 90000, only: true }, async (t) => {
	const sqsClient = new SQSClient({ region: "elasticmq", endpoint: process.env.SQS_ENDPOINT })
	t.teardown(async () => {
		process.exit(0);
	});
	t.beforeEach(async (t) => {
		await sqsPurge(process.env.SQS_URL!);
		const app = Fastify({
			logger: true
		});
		return t.context = {
			app
		}
	});
	t.afterEach(async (t) => {
		try {
			await t.context.app.close();
		}
		catch (e) {
			console.error(e);
		}
	});

	await t.test("plugin definition", async (t) => {
		const { app } = t.context;
		app.register(sqsPlugin, [
			{
				queueUrl: process.env.SQS_URL!,
				waitTimeSeconds: 1,
				handlerFunction: async (message, fastify) => {
					return true;
				},
				sqs: sqsClient
			}
		]);
		app.register(
			fp(async (app, opts) => {}, {
				dependencies: ["fastify-sqs-consumer"]
			})
		);
		await t.resolves(app.ready() as any);
	});

	await t.test("plugin process success message", async (t) => {
		const { app } = t.context;
		const message = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					waitTimeSeconds: 1,
					timeout: 10_000,
					handlerFunction: async (message, fastify) => {
						resolve(message.Body);
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await setTimeout(1000);
		await sendSQS(process.env.SQS_URL!, {
			message: "test"
		}, sqsClient);

		await t.resolveMatch(
			message,
			JSON.stringify({
				message: "test"
			})
		);
	});

	await t.test("plugin process up to 10 messages", async (t) => {
		const { app } = t.context;
		app.register(sqsPlugin, [
			{
				queueUrl: process.env.SQS_URL!,
				waitTimeSeconds: 1,
				timeout: 10_000,
				batchSize: 10,
				handlerFunction: async (message, fastify) => {
					return message.Body;
				},
				sqs: sqsClient
			}
		]);
		await app.ready();
		await setTimeout(1000);
		await Promise.all(
			Array(10)
				.fill(0)
				.map(async (message) => {
					return sendSQS(process.env.SQS_URL!, {
						message
					}, sqsClient);
				}, 10)
		);
		await setTimeout(500);
		const attributes = await getSqsAttributes(process.env.SQS_URL!, ["ApproximateNumberOfMessages"]);
		t.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
	});

	await t.test("plugin process fail message", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			let returnError = true;
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					timeout: 1_000,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						throw Error("error");
					},
					events: {
						processingError: (error) => {
							resolve("handled-error");
							return true;
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await setTimeout(1000);
		await sendSQS(process.env.SQS_URL!, {
			message: "test-error"
		}, sqsClient);

		await t.resolves(messagePromise);
	});

	await t.test("plugin shutdown with messages", async (t) => {
		const { app } = t.context;
		app.register(sqsPlugin, [
			{
				queueUrl: process.env.SQS_URL!,
				timeout: 5_000,
				waitTimeSeconds: 1,
				handlerFunction: async (message, fastify) => {
					await setTimeout(3_000);
					return;
				},
				sqs: sqsClient
			}
		]);
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "test-timeout"
		}, sqsClient);
		await setTimeout(1000);
		await app.close();
		const attributes = await getSqsAttributes(process.env.SQS_URL!, ["ApproximateNumberOfMessages"]);
		t.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
	});

	await t.test("plugin message timeout not handled", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			let count = 0 ;
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					timeout: 1_000,
					waitTimeSeconds: 1,
					attributeNames: ["All"],
					handlerFunction: async (message: Message, fastify) => {
						if(Number(message.Attributes.ApproximateReceiveCount) > 1) {
							resolve(message);
						}
						await setTimeout(2000, "KO");
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "timeout-error"
		}, sqsClient);
		await t.resolves(messagePromise);
	});

	await t.test("plugin message handled timeout", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					timeout: 1_000,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						await setTimeout(5_000, "KO");
					},
					events: {
						timeoutError: (error, message) => {
							resolve(message);
							return false;
						},
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "timeout-error-handled"
		}, sqsClient);

		await t.resolves(messagePromise);
		await app.close();
		await setTimeout(2000);
		const attributes = await getSqsAttributes(process.env.SQS_URL!, ["ApproximateNumberOfMessages"]);
		t.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
	});

	await t.test("plugin handled general error", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: "error",
					handlerFunction: async (message, fastify) => {
						throw Error("simple-error");
					},
					events: {
						error: (error, message) => {
							resolve(message);
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await t.resolves(messagePromise);
	});

	await t.test("plugin process success message handle processing event", async (t) => {
		const { app } = t.context;

		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						await setTimeout(300, "OK");
					},
					events: {
						messageProcessed: (message) => {
							return resolve(message.Body);
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "test-messageProcessed"
		}, sqsClient);
		await t.resolveMatch(
			messagePromise,
			JSON.stringify({
				message: "test-messageProcessed"
			})
		);
	});

	await t.test("plugin process success message handle receiving event", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						return message.Body;
					},
					events: {
						messageReceived: (message) => {
							resolve(message.Body);
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "test"
		}, sqsClient);
		await t.resolveMatch(
			messagePromise,
			JSON.stringify({
				message: "test"
			})
		);
	});

	await t.test("plugin process success message handle response sqs event", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						return message.Body;
					},
					events: {
						responseProcessed: () => {
							resolve("processed");
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "test"
		}, sqsClient);
		await t.resolves(
			messagePromise
		);
	});

	await t.test("plugin process success message handle stopped consumer event", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						return message.Body;
					},
					events: {
						stopped: () => {
							resolve("stopped");
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "test"
		}, sqsClient);
		await app.close();
		await t.resolves(
			messagePromise
		);
	});

	await t.test("plugin process success message handle empty queue event", async (t) => {
		const { app } = t.context;
		const messagePromise = new Promise((resolve, reject) => {
			app.register(sqsPlugin, [
				{
					queueUrl: process.env.SQS_URL!,
					waitTimeSeconds: 1,
					handlerFunction: async (message, fastify) => {
						return message.Body;
					},
					events: {
						empty: () => {
							resolve("empty");
						}
					},
					sqs: sqsClient
				}
			]);
		});
		await app.ready();
		await sendSQS(process.env.SQS_URL!, {
			message: "test"
		}, sqsClient);
		await setTimeout(2_000);
		await t.resolves(
			messagePromise
		);
	});
});