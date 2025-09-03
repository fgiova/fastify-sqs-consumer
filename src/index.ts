import { randomUUID } from "node:crypto";
import type { Message, MiniSQSClient } from "@fgiova/mini-sqs-client";
import { type HooksOptions, SQSConsumer } from "@fgiova/sqs-consumer";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
	interface FastifyInstance {
		sqsConsumers: Record<string, SQSConsumer>;
	}
}

function createConsumer(
	fastify: FastifyInstance,
	queueArn: string,
	handlerFunction: (
		message: Message,
		fastify: FastifyInstance,
	) => Promise<unknown>,
	meta: {
		pendingMessages: number;
	},
	timeout = 90_000,
	waitTimeSeconds = 20,
	batchSize = 1,
	attributeNames: string[] = [],
	messageAttributeNames: string[] = [],
	parallelExecution?: boolean,
	hooks?: HooksOptions,
	sqs?: MiniSQSClient,
) {
	return new SQSConsumer({
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
		},
		handler: async function handleMessageFunction(message: Message) {
			meta.pendingMessages++;
			try {
				await handlerFunction(message, fastify);
				meta.pendingMessages--;
			} catch (e) {
				meta.pendingMessages--;
				fastify.log.error(e);
				throw e;
			}
			return;
		},
	});
}

function sqsConsumerPlugin(
	fastify: FastifyInstance,
	options: {
		arn: string;
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
	const metaData = {
		pendingMessages: 0,
	};

	const consumers: Record<string, SQSConsumer> = {};

	fastify.decorate("sqsConsumers", consumers);

	for (const handler of options) {
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
		} = handler;
		try {
			consumers[name || randomUUID()] = createConsumer(
				fastify,
				queueArn,
				handlerFunction,
				metaData,
				timeout,
				waitTimeSeconds,
				batchSize,
				attributeNames,
				messageAttributeNames,
				parallelExecution,
				events,
				sqs,
			);
		} /* c8 ignore next 3 */ catch (e) {
			fastify.log.error(e);
		}
	}

	fastify.addHook("onReady", (done) => {
		for (const consumer of Object.values(consumers)) {
			consumer.start().catch((e) => fastify.log.error(e));
		}
		done();
	});

	let allStopped = false;

	fastify.addHook("onClose", async (fastify) => {
		const arrayConsumers = Object.values(consumers);

		for (const consumer of arrayConsumers) {
			await consumer.stop();
		}

		const interval = setInterval(() => {
			const isRunning = arrayConsumers.some((consumer) => consumer.isRunning);

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
			if (metaData.pendingMessages <= 0) {
				clearInterval(interval);
				return done();
			} else {
				fastify.log.debug(
					`[fastify-sqs-consumer] ${metaData.pendingMessages} pending messages`,
				);
			}
		}, 50);
	});

	done();
}

export const fastifyPlugin = fp(sqsConsumerPlugin, {
	name: "fastify-sqs-consumer",
	fastify: ">=5.x",
});

export default fastifyPlugin;
