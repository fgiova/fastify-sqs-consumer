import fp from "fastify-plugin";
import { Consumer } from "sqs-consumer";
import { setTimeout } from "timers/promises";

import type { FastifyInstance } from "fastify";
import type { Message } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";

declare module "fastify" {
	interface FastifyInstance {
		sqsConsumers: Consumer[]
	}
};

type eventsHandlers = {
	error?: (error: Error, message: void | Message | Message[]) => void,
	processingError?: (error: Error, message: Message) => void,
	timeoutError?: (error: Error, message: Message) => void | boolean,
	messageReceived?: (message: Message) => void,
	messageProcessed?: (message: Message) => void,
	responseProcessed?: () => void,
	stopped?: () => void,
	empty?: () => void,
};

function createConsumer(
	fastify: FastifyInstance,
	queueUrl: string,
	handlerFunction: (message: Message, fastify: FastifyInstance) => Promise<any>,
	meta: {
		pendingMessages: number,
	},
	timeout = 90_000,
	waitTimeSeconds = 20,
	batchSize = 1,
	attributeNames: string[] = [],
	messageAttributeNames: string[] = [],
	events?: eventsHandlers,
	sqs?: SQSClient
) {
	return Consumer.create({
		queueUrl,
		handleMessageTimeout: 0,
		waitTimeSeconds,
		visibilityTimeout: timeout / 1000,
		batchSize,
		sqs,
		attributeNames,
		messageAttributeNames,
		handleMessage: async function handleMessageFunction(message: Message){
			meta.pendingMessages++;
			try {
				const result = await Promise.race([
					setTimeout(timeout, "timeout"),
					handlerFunction(message, fastify),
				]);
				if (result === "timeout") {
					const TimeoutError = new Error(`Message ${message.MessageId} Timeout after ${timeout}ms`);
					if(events?.timeoutError && typeof events.timeoutError === "function") {
						const timeout = events.timeoutError(TimeoutError, message);
						/* istanbul ignore else */
						if(timeout === false) {
							meta.pendingMessages--;
							return;
						}
					}
					throw TimeoutError;
				}
				meta.pendingMessages--;
			} catch (e) {
				meta.pendingMessages--;
				fastify.log.error(e);
				throw e;
			}
			return;
		}
	})
	.on("error", (err, message) => {
		/* istanbul ignore else */
		if(events?.error) {
			events.error(err, message);
		}
		else {
			fastify.log.error(`[fastify-sqs-consumer] ${err.message}`);
		}
	})
	.on("processing_error", (err, message) => {
		/* istanbul ignore else */
		if(events?.processingError) {
			events.processingError(err, message);
		}
		else {
			fastify.log.error(`[fastify-sqs-consumer] ${err.message}`);
		}
	})
	.on("message_received", (message) => {
		if(events?.messageReceived) events.messageReceived(message);
	})
	.on("message_processed", (message) => {
		if(events?.messageProcessed) events.messageProcessed(message);
	})
	.on("response_processed", () => {
		if(events?.responseProcessed) events.responseProcessed();
	}).on("stopped", () => {
		if(events?.stopped) events.stopped();
	})
	.on("empty", () => {
		/* istanbul ignore next */
		if(events?.empty) events.empty();
	});
}

function sqsConsumerPlugin (fastify: FastifyInstance, options: {
	queueUrl: string;
	handlerFunction: (message: Message, fastify: FastifyInstance) => Promise<any>;
	timeout?: number;
	waitTimeSeconds?: number;
	batchSize?: number;
	attributeNames?: string[],
	messageAttributeNames?: string[],
	events?: eventsHandlers;
	sqs?: SQSClient
}[], done: any) {
	const metaData = {
		pendingMessages: 0
	};
	const consumers: Consumer[] = [];
	fastify.decorate("sqsConsumers", consumers);

	for(const handler of options) {
		const {
			queueUrl,
			handlerFunction,
			timeout,
			waitTimeSeconds,
			batchSize,
			attributeNames,
			messageAttributeNames,
			events,
			sqs
		} = handler;

		consumers.push(createConsumer(
			fastify,
			queueUrl,
			handlerFunction,
			metaData,
			timeout,
			waitTimeSeconds,
			batchSize,
			attributeNames,
			messageAttributeNames,
			events,
			sqs
		));
	}

	fastify.addHook("onReady", (done) => {
		for (const consumer of consumers) {
			consumer.start();
		}
		done();
	});
    let allStopped = false;
	fastify.addHook("onClose", (fastify, done) => {
		for (const consumer of consumers) {
			consumer.stop();
			consumer.removeAllListeners();
		}
		const interval = setInterval(() => {
			const isRunning = consumers.some((consumer) => consumer.isRunning);
			/* istanbul ignore next */
			if (isRunning) {
				fastify.log.debug("[fastify-sqs-consumer] Some consumers still running... please wait");
				return null;
			}
			else if(!allStopped) {
				allStopped = true;
				fastify.log.debug("[fastify-sqs-consumer] All consumers are stopped");
			}
			if (metaData.pendingMessages <= 0) {
				clearInterval(interval);
				return done();
			}
			else {
				fastify.log.debug(`[fastify-sqs-consumer] ${metaData.pendingMessages} pending messages`);
			}
		}, 50);
	});

	done();
}

export = fp(sqsConsumerPlugin, {
	name: "fastify-sqs-consumer",
	fastify: ">=4.x"
});