// @ts-ignore
import path from "path"
// @ts-ignore
import fs from "fs";
import {Socket} from "net";
import {teardown} from "tap";
// @ts-ignore
import dotenv from "dotenv";

const defaultExport = () => {
	dotenv.config({
		path: ".env.dev"
	});
	if(!process.env.TEST_LOCAL) {
		const jsonString = fs.readFileSync(path.resolve(process.cwd(), "test-env.json"), {
			encoding: "utf8"
		});
		try {
			const envConfig = JSON.parse(jsonString);

			for (const key in envConfig) {
				process.env[key] = envConfig[key];
			}
		} catch (err) {
			console.error(err);
		}
	}
	if(process.env.REAPER) {
		const [host, port] = process.env.REAPER.split(":");
		const socket = new Socket();
		socket.connect(Number(port), host, () => {
			socket.write(`label=org.testcontainers.session-id=${process.env.REAPER_SESSION}\r\n`);
			socket.write(`label=org.testcontainers.session-id=${process.env.REAPER_SESSION}--\r\n`);
		})
		.on("error", (error) => {
			console.error(error);
		});

		// @ts-ignore
		teardown(() => socket.destroy())
	}
}
defaultExport();