import { randomUUID } from "node:crypto";
import type { Message, MiniSQSClient } from "@fgiova/mini-sqs-client";
import { type HooksOptions, SQSConsumer } from "@fgiova/sqs-consumer";
// @ts-expect-error
import { Unpromise } from "@watchable/unpromise";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
	interface FastifyInstance {
		sqsConsumers: Record<
			string,
			{ consumer: SQSConsumer; meta: { pendingMessages: number } }
		>;
	}
}

function createConsumer(
	fastify: FastifyInstance,
	queueArn: string,
	handlerFunction: (
		message: Message,
		fastify: FastifyInstance,
	) => Promise<unknown>,
	timeout = 90_000,
	waitTimeSeconds = 20,
	batchSize = 1,
	attributeNames: string[] = [],
	messageAttributeNames: string[] = [],
	parallelExecution?: boolean,
	hooks?: HooksOptions,
	sqs?: MiniSQSClient,
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	},
) {
	const meta = { pendingMessages: 0 };
	return {
		consumer: new SQSConsumer({
			queueARN: queueArn,
			autostart: false,
			consumerOptions: {
				waitTimeSeconds,
				itemsPerRequest: batchSize,
				attributeNames,
				messageAttributeNames,
				visibilityTimeout: timeout / 1000,
			},
			handlerOptions: {
				executionTimeout: timeout,
				parallelExecution,
			},
			hooks,
			clientOptions: {
				sqsClient: sqs,
				/* c8 ignore next 1 */
				signer: credentials ? { credentials } : undefined,
			},
			handler: async function handleMessageFunction(message: Message) {
				let timeoutId: ReturnType<typeof setTimeout>;
				meta.pendingMessages++;
				try {
					return await Unpromise.race([
						handlerFunction(message, fastify),
						new Promise<never>((_, reject) => {
							timeoutId = setTimeout(
								() => reject(new Error("Handler execution timed out")),
								timeout + 1000, // Adding a buffer to ensure execution timeout is handled correctly
							);
						}),
					]);
				} catch (e) {
					fastify.log.error(e);
					throw e;
					/* c8 ignore next */
				} finally {
					// biome-ignore lint/style/noNonNullAssertion: TimeoutId is always set before this line is reached
					clearTimeout(timeoutId!);
					meta.pendingMessages--;
				}
			},
		}),
		meta,
	};
}

function sqsConsumerPlugin(
	fastify: FastifyInstance,
	options: {
		arn: string;
		credentials?: {
			accessKeyId: string;
			secretAccessKey: string;
		};
		name?: string;
		handlerFunction: (
			message: Message,
			fastify: FastifyInstance,
		) => Promise<unknown>;
		timeout?: number;
		waitTimeSeconds?: number;
		batchSize?: number;
		messageAttributeNames?: string[];
		attributeNames?: string[];
		events?: HooksOptions;
		parallelExecution?: boolean;
		sqs?: MiniSQSClient;
	}[],
	done: (err?: Error) => void,
) {
	const consumers: Record<
		string,
		{
			consumer: SQSConsumer;
			meta: { pendingMessages: number };
		}
	> = {};

	let maxExecutionTimeout = 90_000;

	fastify.decorate("sqsConsumers", consumers);

	for (const handler of options) {
		maxExecutionTimeout = Math.max(maxExecutionTimeout, handler.timeout ?? 0);
		const {
			name,
			arn: queueArn,
			handlerFunction,
			timeout,
			waitTimeSeconds,
			batchSize,
			attributeNames,
			messageAttributeNames,
			events,
			sqs,
			parallelExecution,
			credentials,
		} = handler;
		try {
			consumers[name || randomUUID()] = createConsumer(
				fastify,
				queueArn,
				handlerFunction,
				timeout,
				waitTimeSeconds,
				batchSize,
				attributeNames,
				messageAttributeNames,
				parallelExecution,
				events,
				sqs,
				credentials,
			);
		} /* c8 ignore next 3 */ catch (e) {
			fastify.log.error(e);
		}
	}

	fastify.addHook("onReady", (done) => {
		for (const consumerName of Object.keys(consumers)) {
			consumers[consumerName].consumer.start().catch((e) => {
				fastify.log.error(e);
				delete consumers[consumerName];
			});
		}
		done();
	});

	fastify.addHook("onClose", (fastify, done) => {
		let allStopped = false;
		const arrayConsumers = Object.values(consumers);
		const timeStart = Date.now();

		for (const consumer of arrayConsumers) {
			consumer.consumer
				.stop()
				.catch((e) =>
					fastify.log.error(
						`[fastify-sqs-consumer] Error stopping consumer: ${e}`,
					),
				);
		}

		const interval = setInterval(() => {
			const isRunning = arrayConsumers.some(
				(consumer) => consumer.consumer.isRunning,
			);
			const pendingMessages = arrayConsumers.reduce(
				(acc, consumer) => acc + consumer.meta.pendingMessages,
				0,
			);

			if (Date.now() - timeStart > maxExecutionTimeout + 2_000) {
				fastify.log.warn(
					"[fastify-sqs-consumer] Consumers are taking too long to stop... forcing shutdown",
				);
				clearInterval(interval);
				return done();
			}

			/* c8 ignore next 5 */
			if (isRunning) {
				fastify.log.debug(
					"[fastify-sqs-consumer] Some consumers still running... please wait",
				);
				return null;
			} else if (!allStopped) {
				allStopped = true;
				fastify.log.debug("[fastify-sqs-consumer] All consumers are stopped");
			}
			if (pendingMessages <= 0) {
				clearInterval(interval);
				return done();
			} else {
				fastify.log.debug(
					`[fastify-sqs-consumer] ${pendingMessages} pending messages`,
				);
			}
		}, 500);
	});

	done();
}

export const fastifyPlugin = fp(sqsConsumerPlugin, {
	name: "fastify-sqs-consumer",
	fastify: ">=5.x",
});

export default fastifyPlugin;
