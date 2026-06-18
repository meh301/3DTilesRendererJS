import { searchForWorkspaceRoot, loadEnv } from "vite";
import fs from "fs";
import path from "path";

function rewriteRootPlugin(target) {
	return {
		name: "rewrite-root",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url === "/" || req.url === "/index.html") {
					req.url = target;
				}
				next();
			});
		},
	};
}

function datasetsMiddlewarePlugin() {
	return {
		name: "datasets-middleware",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url.startsWith("/datasets/")) {
					const filePath = path.join(
						process.cwd(),
						"datasets",
						req.url.replace("/datasets/", "")
					);
					if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
						res.setHeader("Content-Type", "application/octet-stream");
						fs.createReadStream(filePath).pipe(res);
						return;
					}
				}
				next();
			});
		},
	};
}

export default ({ mode }) => {
	process.env = { ...process.env, ...loadEnv(mode, process.cwd()) };

	return {
		root: "./example/",
		envDir: ".",
		base: "",
		build: {
			outDir: "./bundle-spatialid/",
			rollupOptions: {
				input: "./example/googleMapsExample.html",
			},
		},
		server: {
			host: "0.0.0.0",
			port: 3001,
			allowedHosts: true,
			fs: {
				allow: [searchForWorkspaceRoot(process.cwd())],
			},
		},
		plugins: [
			rewriteRootPlugin("/googleMapsExample.html"),
			datasetsMiddlewarePlugin(),
		],
	};
};
