import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type Message, MiniSQSClient } from "@fgiova/mini-sqs-client";
import { type HooksOptions, SQSConsumer } from "@fgiova/sqs-consumer";
// @ts-expect-error
import { Unpromise } from "@watchable/unpromise";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Pool } from "undici";

type ConsumerEntry = {
	consumer: SQSConsumer;
	meta: { pendingMessages: number };
	ownedClient?: MiniSQSClient;
};

export type ConsumerOptions = {
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
	sqs?:
		| MiniSQSClient
		| {
				endpoint?: string;
				undiciOptions?: Pool.Options;
				credentials?: {
					accessKeyId: string;
					secretAccessKey: string;
				};
		  };
};

declare module "fastify" {
	interface FastifyInstance {
		sqsConsumers: Record<string, ConsumerEntry>;
		addSQSConsumer: (consumerOptions: ConsumerOptions) => string | null;
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
	sqs?:
		| MiniSQSClient
		| {
				endpoint?: string;
				undiciOptions?: Pool.Options;
				credentials?: {
					accessKeyId: string;
					secretAccessKey: string;
				};
		  },
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	},
): ConsumerEntry {
	const meta = { pendingMessages: 0 };
	let ownedClient: MiniSQSClient | undefined;
	if (!(sqs instanceof MiniSQSClient)) {
		credentials = credentials ?? sqs?.credentials;
		ownedClient = new MiniSQSClient(
			queueArn.split(":")[3],
			sqs?.endpoint,
			sqs?.undiciOptions,
			/* c8 ignore next 1 */
			credentials ? { credentials } : undefined,
		);
	}
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
				sqsClient: ownedClient ?? (sqs as MiniSQSClient),
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
								timeout + 1000, // frees pendingMessages even if handlerFunction never settles
							).unref();
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
		ownedClient,
	};
}

function sqsConsumerPlugin(
	fastify: FastifyInstance,
	options: ConsumerOptions[],
	done: (err?: Error) => void,
) {
	const consumers: Record<string, ConsumerEntry> = Object.create(null);

	let maxExecutionTimeout = 90_000;

	let isClosing = false;

	let isReady = false;

	fastify.decorate("sqsConsumers", consumers);

	const startConsumer = (consumerName: string) => {
		const { consumer, ownedClient } = consumers[consumerName];
		const consumerStart = consumer.start();

		consumerStart.catch(async (e) => {
			fastify.log.error(e);
			delete consumers[consumerName];
			await consumer.stop().catch((stopErr) => fastify.log.error(stopErr));
			await ownedClient?.destroy().catch((err) => fastify.log.error(err));
		});

		return consumerStart;
	};

	const addSQSConsumer = (consumerOptions: ConsumerOptions) => {
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
		} = consumerOptions;

		const consumerName = name || randomUUID();

		if (consumers[consumerName]) {
			fastify.log.warn(
				`[fastify-sqs-consumer] Consumer with name ${consumerName} already exists. Skipping creation.`,
			);
			return null;
		}

		if (isClosing) {
			fastify.log.warn(
				`[fastify-sqs-consumer] Cannot add consumer ${consumerName} while closing. Skipping creation.`,
			);
			return null;
		}

		maxExecutionTimeout = Math.max(
			maxExecutionTimeout,
			consumerOptions.timeout ?? 0,
		);

		try {
			consumers[consumerName] = createConsumer(
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

			if (isReady) {
				void startConsumer(consumerName);
			}

			return consumerName;
		} /* c8 ignore next 4 */ catch (e) {
			fastify.log.error(e);
			return null;
		}
	};

	fastify.decorate("addSQSConsumer", addSQSConsumer);

	for (const handler of options) {
		addSQSConsumer(handler);
	}

	fastify.addHook("onReady", (done) => {
		isReady = true;
		for (const consumerName of Object.keys(consumers)) {
			void startConsumer(consumerName);
		}
		done();
	});

	fastify.addHook("preClose", async () => {
		isClosing = true;
	});

	fastify.addHook("onClose", async () => {
		const arrayConsumers = Object.values(consumers);
		const deadline = Date.now() + maxExecutionTimeout + 2_000;
		let stopped = false;

		Promise.allSettled(
			arrayConsumers.map(({ consumer }) =>
				consumer
					.stop()
					.catch((e) =>
						fastify.log.error(
							`[fastify-sqs-consumer] Error stopping consumer: ${e}`,
						),
					),
			),
		).then(() => {
			stopped = true;
		});

		while (
			!stopped ||
			arrayConsumers.some(({ meta }) => meta.pendingMessages > 0)
		) {
			if (Date.now() > deadline) {
				fastify.log.warn(
					"[fastify-sqs-consumer] Consumers are taking too long to stop... forcing shutdown",
				);
				break;
			}
			await sleep(500);
		}

		await Promise.allSettled(
			arrayConsumers.map(({ ownedClient }) => ownedClient?.destroy()),
		);
	});

	done();
}

export const fastifyPlugin = fp(sqsConsumerPlugin, {
	name: "fastify-sqs-consumer",
	fastify: ">=5.x",
});

export default fastifyPlugin;
