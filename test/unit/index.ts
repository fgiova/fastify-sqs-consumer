import { test } from "tap";
// biome-ignore lint/suspicious/noTsIgnore: is a Test file
// @ts-ignore
import "../helpers/localtest";
import { setTimeout } from "node:timers/promises";
import { type Message, SQSClient } from "@aws-sdk/client-sqs";
import {
	type Message as MiniMessage,
	MiniSQSClient,
} from "@fgiova/mini-sqs-client";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
// biome-ignore lint/suspicious/noTsIgnore: is a Test file
// @ts-ignore
import sqsPlugin from "../../src";
// biome-ignore lint/suspicious/noTsIgnore: is a Test file
// @ts-ignore
import { getSqsAttributes, sendSQS, sqsPurge } from "../helpers/sqsMessage";

const queueArn = "arn:aws:sqs:eu-central-1:000000000000:test-queue";
const queueUrl = `${process.env.LOCALSTACK_ENDPOINT}/000000000000/test-queue`;

test("sqs", async (t) => {
	const sqsClient = new SQSClient({
		region: "eu-central-1",
		endpoint: process.env.LOCALSTACK_ENDPOINT,
	});
	const client = new MiniSQSClient(
		"eu-central-1",
		process.env.LOCALSTACK_ENDPOINT,
		undefined,
	);

	t.teardown(async () => {
		process.exit(0);
	});

	t.beforeEach(async (t) => {
		await sqsPurge(queueUrl);
		const app = Fastify({
			logger: false,
		});
		t.context = {
			app,
		};
	});

	t.afterEach(async (t) => {
		try {
			await t.context.app.close();
		} catch (e) {
			console.error(e);
		}
	});

	await t.test("plugin definition", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async (
					_message: Message,
					_fastify: FastifyInstance,
				) => {
					return true;
				},
			},
		]);
		app.register(
			fp(async () => {}, {
				dependencies: ["fastify-sqs-consumer"],
			}),
		);
		await t.resolves(app.ready() as unknown as Promise<FastifyInstance>);
		t.ok(app.sqsConsumers);
		t.equal(Object.keys(app.sqsConsumers).length, 1);
	});

	await t.test("plugin process success message", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const message = new Promise((resolve, _reject) => {
			app.register(sqsPlugin, [
				{
					arn: queueArn,
					sqs: client,
					waitTimeSeconds: 1,
					timeout: 10_000,
					handlerFunction: async (
						message: Message,
						_fastify: FastifyInstance,
					) => {
						resolve(message.Body);
					},
				},
			]);
		});
		await app.ready();
		await setTimeout(1000);
		await sendSQS(
			queueUrl,
			{
				message: "test",
			},
			sqsClient,
		);

		await t.resolveMatch(
			message,
			JSON.stringify({
				message: "test",
			}),
		);
	});

	await t.test("plugin process up to 10 messages", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				sqs: client,
				waitTimeSeconds: 1,
				timeout: 10_000,
				batchSize: 10,
				handlerFunction: async (
					message: Message,
					_fastify: FastifyInstance,
				) => {
					return message.Body;
				},
			},
		]);
		await app.ready();
		await setTimeout(1000);
		await Promise.all(
			Array(10)
				.fill(0)
				.map(async (message) => {
					return sendSQS(
						queueUrl,
						{
							message,
						},
						sqsClient,
					);
				}, 10),
		);
		await setTimeout(500);
		const attributes = await getSqsAttributes(queueUrl, [
			"ApproximateNumberOfMessages",
		]);
		t.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
	});

	await t.test("plugin process fail message", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const messagePromise = new Promise((resolve, _reject) => {
			app.register(sqsPlugin, [
				{
					arn: queueArn,
					sqs: client,
					timeout: 1_000,
					waitTimeSeconds: 1,
					handlerFunction: async (
						_message: Message,
						_fastify: FastifyInstance,
					) => {
						return Promise.reject("error");
					},
					events: {
						onError: () => {
							resolve("handled-error");
						},
					},
				},
			]);
		});
		await app.ready();
		await setTimeout(1000);
		await sendSQS(
			queueUrl,
			{
				message: "test-error",
			},
			sqsClient,
		);

		await t.resolves(messagePromise);
	});

	await t.test("plugin shutdown with messages", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				sqs: client,
				timeout: 5_000,
				waitTimeSeconds: 1,
				handlerFunction: async (
					_message: Message,
					_fastify: FastifyInstance,
				) => {
					await setTimeout(3_000);
					return;
				},
			},
		]);
		await app.ready();
		await sendSQS(
			queueUrl,
			{
				message: "test-timeout",
			},
			sqsClient,
		);
		await setTimeout(1000);
		await app.close();
		const attributes = await getSqsAttributes(queueUrl, [
			"ApproximateNumberOfMessages",
		]);
		t.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
	});

	await t.test(
		"plugin message timeout not handled",
		{ only: true },
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			const messagePromise = new Promise((resolve, _reject) => {
				app.register(sqsPlugin, [
					{
						arn: queueArn,
						sqs: client,
						timeout: 1_000,
						waitTimeSeconds: 1,
						attributeNames: ["All"],
						handlerFunction: async (
							message: Message,
							_fastify: FastifyInstance,
						) => {
							if (Number(message.Attributes?.ApproximateReceiveCount) > 1) {
								resolve(message);
							}
							await setTimeout(2000, "KO");
						},
					},
				]);
			});
			await app.ready();
			await sendSQS(
				queueUrl,
				{
					message: "timeout-error",
				},
				sqsClient,
			);
			await t.resolves(messagePromise);
		},
	);

	await t.test("plugin message handled timeout", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const messagePromise = new Promise((resolve, _reject) => {
			app.register(sqsPlugin, [
				{
					arn: queueArn,
					sqs: client,
					timeout: 1_000,
					waitTimeSeconds: 10,
					handlerFunction: async (
						_message: Message,
						_fastify: FastifyInstance,
					) => {
						await setTimeout(2_000, "KO");
					},
					events: {
						onHandlerTimeout: async (message: MiniMessage) => {
							resolve(message);
							await sqsPurge(queueUrl);
						},
					},
				},
			]);
		});
		await app.ready();
		await sendSQS(
			queueUrl,
			{
				message: "timeout-error-handled",
			},
			sqsClient,
		);

		await t.resolves(messagePromise);
		await app.close();
		await setTimeout(2000);
		const attributes = await getSqsAttributes(queueUrl, [
			"ApproximateNumberOfMessages",
		]);
		t.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
	});

	await t.test(
		"plugin process success message handle processing event",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };

			const messagePromise = new Promise((resolve, _reject) => {
				app.register(sqsPlugin, [
					{
						arn: queueArn,
						sqs: client,
						waitTimeSeconds: 1,
						handlerFunction: async (
							_message: Message,
							_fastify: FastifyInstance,
						) => {
							await setTimeout(300, "OK");
						},
						events: {
							onHandlerSuccess: (message: MiniMessage) => {
								resolve(message.Body);
							},
						},
					},
				]);
			});
			await app.ready();
			await sendSQS(
				queueUrl,
				{
					message: "test-messageProcessed",
				},
				sqsClient,
			);
			await t.resolveMatch(
				messagePromise,
				JSON.stringify({
					message: "test-messageProcessed",
				}),
			);
		},
	);

	await t.test(
		"plugin process success message handle receiving event",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			const messagePromise = new Promise((resolve, _reject) => {
				app.register(sqsPlugin, [
					{
						arn: queueArn,
						sqs: client,
						waitTimeSeconds: 1,
						handlerFunction: async (
							message: Message,
							_fastify: FastifyInstance,
						) => {
							return message.Body;
						},
						events: {
							onMessage: (message: MiniMessage) => {
								resolve(message.Body);
							},
						},
					},
				]);
			});
			await app.ready();
			await sendSQS(
				queueUrl,
				{
					message: "test",
				},
				sqsClient,
			);
			await t.resolveMatch(
				messagePromise,
				JSON.stringify({
					message: "test",
				}),
			);
		},
	);

	await t.test(
		"plugin process success message handle response sqs event",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			const messagePromise = new Promise((resolve, _reject) => {
				app.register(sqsPlugin, [
					{
						arn: queueArn,
						sqs: client,
						waitTimeSeconds: 1,
						handlerFunction: async (
							message: Message,
							_fastify: FastifyInstance,
						) => {
							return message.Body;
						},
						events: {
							onSuccess: () => {
								resolve("processed");
							},
						},
					},
				]);
			});
			await app.ready();
			await sendSQS(
				queueUrl,
				{
					message: "test",
				},
				sqsClient,
			);
			await t.resolves(messagePromise);
		},
	);

	await t.test(
		"plugin process success message with sqs options object",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			const message = new Promise((resolve, _reject) => {
				app.register(sqsPlugin, [
					{
						arn: queueArn,
						sqs: {
							endpoint: process.env.LOCALSTACK_ENDPOINT,
							undiciOptions: { connections: 1 },
							credentials: {
								accessKeyId: "AWS_ACCESS_KEY_ID",
								secretAccessKey: "AWS_SECRET_ACCESS_KEY",
							},
						},
						waitTimeSeconds: 1,
						timeout: 10_000,
						handlerFunction: async (
							message: Message,
							_fastify: FastifyInstance,
						) => {
							resolve(message.Body);
						},
					},
				]);
			});
			await app.ready();
			await setTimeout(1000);
			await sendSQS(
				queueUrl,
				{
					message: "test-options",
				},
				sqsClient,
			);

			await t.resolveMatch(
				message,
				JSON.stringify({
					message: "test-options",
				}),
			);
		},
	);

	await t.test(
		"plugin process success message with sqs options object and top-level credentials",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			const message = new Promise((resolve, _reject) => {
				app.register(sqsPlugin, [
					{
						arn: queueArn,
						sqs: {
							endpoint: process.env.LOCALSTACK_ENDPOINT,
						},
						credentials: {
							accessKeyId: "AWS_ACCESS_KEY_ID",
							secretAccessKey: "AWS_SECRET_ACCESS_KEY",
						},
						waitTimeSeconds: 1,
						timeout: 10_000,
						handlerFunction: async (
							message: Message,
							_fastify: FastifyInstance,
						) => {
							resolve(message.Body);
						},
					},
				]);
			});
			await app.ready();
			await setTimeout(1000);
			await sendSQS(
				queueUrl,
				{
					message: "test-options-credentials",
				},
				sqsClient,
			);

			await t.resolveMatch(
				message,
				JSON.stringify({
					message: "test-options-credentials",
				}),
			);
		},
	);

	await t.test("plugin onReady consumer start failure", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				name: "test-start-fail",
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async (
					_message: Message,
					_fastify: FastifyInstance,
				) => {
					return true;
				},
			},
		]);
		app.after(() => {
			const consumer = app.sqsConsumers["test-start-fail"];
			consumer.consumer.start = async () => {
				throw new Error("start failed");
			};
		});
		await app.ready();
		await setTimeout(500);
		t.notOk(app.sqsConsumers["test-start-fail"]);
	});

	await t.test(
		"plugin onReady start failure destroys owned client",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			let destroyed = false;
			app.register(sqsPlugin, [
				{
					arn: queueArn,
					name: "test-start-fail-owned",
					sqs: { endpoint: process.env.LOCALSTACK_ENDPOINT },
					waitTimeSeconds: 1,
					handlerFunction: async () => true,
				},
			]);
			app.after(() => {
				const entry = app.sqsConsumers["test-start-fail-owned"];
				entry.consumer.start = async () => {
					throw new Error("start failed");
				};
				const ownedClient = entry.ownedClient as MiniSQSClient;
				const destroy = ownedClient.destroy.bind(ownedClient);
				ownedClient.destroy = async (...args) => {
					destroyed = true;
					return destroy(...args);
				};
			});
			await app.ready();
			await setTimeout(500);
			t.notOk(app.sqsConsumers["test-start-fail-owned"]);
			t.ok(destroyed);
		},
	);

	await t.test("plugin onClose destroys owned client only", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const calls: string[] = [];
		const userDestroy = client.destroy;
		client.destroy = async () => {
			calls.push("user");
			return [undefined, true];
		};
		t.teardown(() => {
			client.destroy = userDestroy;
		});
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				name: "owned",
				sqs: { endpoint: process.env.LOCALSTACK_ENDPOINT },
				waitTimeSeconds: 1,
				handlerFunction: async () => true,
			},
			{
				arn: queueArn,
				name: "user",
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async () => true,
			},
		]);
		await app.ready();
		t.notOk(app.sqsConsumers.user.ownedClient);
		const ownedClient = app.sqsConsumers.owned.ownedClient as MiniSQSClient;
		const destroy = ownedClient.destroy.bind(ownedClient);
		ownedClient.destroy = async (...args) => {
			calls.push("owned");
			return destroy(...args);
		};
		await setTimeout(500);
		await app.close();
		t.same(calls, ["owned"]);
		t.notOk(app.sqsConsumers.owned.consumer.isRunning);
	});

	await t.test("plugin onClose stop error", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				name: "test-stop-error",
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async (
					_message: Message,
					_fastify: FastifyInstance,
				) => {
					return true;
				},
			},
		]);
		await app.ready();
		await setTimeout(1000);

		const consumer = app.sqsConsumers["test-stop-error"];
		const originalStop = consumer.consumer.stop.bind(consumer.consumer);
		consumer.consumer.stop = async () => {
			throw new Error("stop error");
		};
		Object.defineProperty(consumer.consumer, "isRunning", {
			get: () => false,
		});

		await t.resolves(app.close());

		// Cleanup: actually stop the consumer so it does not steal messages from later tests
		await originalStop();
	});

	await t.test("plugin onClose force shutdown timeout", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				name: "test-force-shutdown",
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async (
					_message: Message,
					_fastify: FastifyInstance,
				) => {
					return true;
				},
			},
		]);
		await app.ready();
		await setTimeout(1000);

		const consumer = app.sqsConsumers["test-force-shutdown"];
		const originalStop = consumer.consumer.stop.bind(consumer.consumer);
		consumer.consumer.stop = () => new Promise(() => {});
		consumer.meta.pendingMessages = 1;

		const originalDateNow = Date.now;
		let timeOffset = 0;
		Date.now = () => originalDateNow() + timeOffset;

		const closePromise = app.close();

		// Set offset after close starts (timeStart captured with offset=0)
		// but before first interval tick at 500ms
		globalThis.setTimeout(() => {
			timeOffset = 93_001;
		}, 300);

		await closePromise;
		Date.now = originalDateNow;

		// Cleanup: actually stop the consumer to prevent background polling
		await originalStop();
		t.pass("force shutdown completed");
	});

	await t.test("addSQSConsumer before ready starts on ready", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		let consumerName: string | null = null;
		app.register(sqsPlugin, []);
		app.after(() => {
			consumerName = app.addSQSConsumer({
				arn: queueArn,
				name: "added-before-ready",
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async () => true,
			});
			t.notOk(app.sqsConsumers["added-before-ready"].consumer.isRunning);
		});
		await app.ready();
		t.equal(consumerName, "added-before-ready");
		t.ok(app.sqsConsumers["added-before-ready"].consumer.isRunning);
	});

	await t.test(
		"addSQSConsumer after ready starts immediately and processes messages",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			app.register(sqsPlugin, []);
			await app.ready();

			let resolveMessage: (body: unknown) => void = () => {};
			const message = new Promise((resolve) => {
				resolveMessage = resolve;
			});
			const consumerName = app.addSQSConsumer({
				arn: queueArn,
				sqs: client,
				waitTimeSeconds: 1,
				timeout: 10_000,
				handlerFunction: async (message: MiniMessage) => {
					resolveMessage(message.Body);
				},
			}) as string;

			t.match(consumerName, /^[0-9a-f-]{36}$/);
			t.ok(app.sqsConsumers[consumerName].consumer.isRunning);

			await sendSQS(queueUrl, { message: "test-added-after-ready" }, sqsClient);
			await t.resolveMatch(
				message,
				JSON.stringify({ message: "test-added-after-ready" }),
			);
		},
	);

	await t.test("addSQSConsumer duplicate name returns null", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, [
			{
				arn: queueArn,
				name: "duplicated",
				sqs: client,
				waitTimeSeconds: 1,
				handlerFunction: async () => true,
			},
		]);
		await app.ready();
		const original = app.sqsConsumers.duplicated;
		t.equal(
			app.addSQSConsumer({
				arn: queueArn,
				name: "duplicated",
				sqs: client,
				handlerFunction: async () => true,
			}),
			null,
		);
		t.equal(app.sqsConsumers.duplicated, original);
	});

	await t.test("addSQSConsumer while closing returns null", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, []);
		let addedOnClose: string | null | undefined;
		app.addHook("onClose", async () => {
			addedOnClose = app.addSQSConsumer({
				arn: queueArn,
				name: "added-on-close",
				sqs: client,
				handlerFunction: async () => true,
			});
		});
		await app.ready();
		await app.close();
		t.equal(addedOnClose, null);
		t.notOk(app.sqsConsumers["added-on-close"]);
	});

	await t.test("addSQSConsumer accepts Object.prototype names", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(sqsPlugin, []);
		await app.ready();
		const consumerName = app.addSQSConsumer({
			arn: queueArn,
			name: "constructor",
			sqs: client,
			waitTimeSeconds: 1,
			handlerFunction: async () => true,
		}) as string;
		t.equal(consumerName, "constructor");
		t.ok(app.sqsConsumers[consumerName].consumer.isRunning);
	});
});
