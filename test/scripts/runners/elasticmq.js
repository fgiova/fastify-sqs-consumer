const { GenericContainer, Wait }  = require("testcontainers");
const path = require("path")
const {setTimeout} = require("timers/promises");

const startEMQ = async () => {
	const sqs = await new GenericContainer("softwaremill/elasticmq:latest")
		.withCopyFilesToContainer([
			{
				source: path.resolve(__dirname, "../volumes/customEMQ.conf"),
				target: "/opt/elasticmq.conf"
			}
		])
		.withExposedPorts(9324)
		.withWaitStrategy(Wait.forLogMessage("=== ElasticMQ server"))
		.start();
	await setTimeout(1000);
	const port = sqs.getMappedPort(9324);
	const host = sqs.getHost();
	return {
		container: sqs,
		port,
		host
	};
}

const stopEMQ = async (container) => {
	await container.stop();
}

module.exports = {
	startEMQ,
	stopEMQ
}