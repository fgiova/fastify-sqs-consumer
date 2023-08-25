import { SQSClient, SendMessageCommand, GetQueueAttributesCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";

const sendSQS = (queueUrl: string, body: any, client?: SQSClient ) => {
	const params = {
		MessageBody: JSON.stringify(body),
		QueueUrl: queueUrl
	};
	const sqs = client ?? new SQSClient({
		region: "elasticmq",
		endpoint: process.env.SQS_URL
	});
	return sqs.send(new SendMessageCommand(params));
};

const getSqsAttributes = (queueUrl: string, attributeNames: string[]) => {
	const params = {
		AttributeNames: attributeNames,
		QueueUrl: queueUrl
	};
	const sqs = new SQSClient({
		region: "elasticmq",
		endpoint: process.env.SQS_URL,
	});
	return sqs.send(new GetQueueAttributesCommand(params));
};

const sqsPurge = async (queueUrl: string) => {
	const sqs = new SQSClient({
		region: "elasticmq",
		endpoint: process.env.SQS_URL
	});
	await sqs
		.send(new PurgeQueueCommand({
			QueueUrl: queueUrl
		}));
	while (true) {
		const result = await sqs.send(new GetQueueAttributesCommand({
			AttributeNames: ["ApproximateNumberOfMessages"],
			QueueUrl: queueUrl
		}));
		if (result.Attributes?.ApproximateNumberOfMessages === "0") {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
};

export { sendSQS, sqsPurge, getSqsAttributes };