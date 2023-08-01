const { startEMQ } = require("../runners/elasticmq");
const { writeFile } = require("fs/promises");
const { getReaper } = require("testcontainers/build/reaper/reaper");
const {getContainerRuntimeClient} = require("testcontainers/build/container-runtime/clients/client");

const startReaper = async () => {
    const containerRuntimeClient = await getContainerRuntimeClient();
    await getReaper(containerRuntimeClient);
    const runningContainers = await containerRuntimeClient.container.list();
    const reaper = runningContainers.find((container) => container.Labels["org.testcontainers.ryuk"] === "true");
    const reaperNetwork = reaper.Ports.find((port) => port.PrivatePort == 8080);
    const reaperPort = reaperNetwork.PublicPort;
    const reaperIp = reaperNetwork.IP;
    const reaperSessionId = reaper.Labels["org.testcontainers.session-id"] ;
    return {
        REAPER: `${reaperIp}:${reaperPort}`,
        REAPER_SESSION: reaperSessionId,
    }
};

const before = async () => {
    if(!process.env.TEST_LOCAL) {
        console.log("Start Reaper");
        const reaperEnv = await startReaper();
        console.log("Start ElasticMQ");
        const {container: sqsContainer, port: sqsPort, host: sqsHost} = await startEMQ();
        process.env.SQS_URL = `http://${sqsHost}:${sqsPort}/queue/notifications`;
        await writeFile("test-env.json", JSON.stringify({
            ...reaperEnv,
            sqsContainer:sqsContainer.getId(),
            SQS_URL: process.env.SQS_URL,
            SQS_ENDPOINT: `http://${sqsHost}:${sqsPort}`,
        }))
    }
}

module.exports = before();