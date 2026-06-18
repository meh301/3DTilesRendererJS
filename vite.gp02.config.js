import { searchForWorkspaceRoot, loadEnv } from "vite";

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

export default ({ mode }) => {
	process.env = { ...process.env, ...loadEnv(mode, process.cwd()) };

	return {
		root: "./example/",
		envDir: ".",
		base: "",
		build: {
			outDir: "./bundle-gp02/",
			rollupOptions: {
				input: "./example/gp02tracker.html",
			},
		},
		server: {
			host: "0.0.0.0",
			port: 3002,
			allowedHosts: true,
			fs: {
				allow: [searchForWorkspaceRoot(process.cwd())],
			},
		},
		plugins: [rewriteRootPlugin("/gp02tracker.html")],
	};
};
