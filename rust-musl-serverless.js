"use strict";

// https://serverless.com/blog/writing-serverless-plugins/
// https://serverless.com/framework/docs/providers/aws/guide/plugins/
// https://github.com/softprops/lambda-rust/

const {
    spawnSync
} = require("child_process");
const {
    homedir
} = require("os");
var fs = require('fs');
const path = require("path");
const util = require('util');
var AdmZip = require('adm-zip');


const RUST_RUNTIME = "rust";
const BASE_RUNTIME = "provided";
const NO_OUTPUT_CAPTURE = {
    stdio: ["ignore", process.stdout, process.stderr]
};

function includeInvokeHook(serverlessVersion) {
    let [major, minor] = serverlessVersion.split(".");
    let majorVersion = parseInt(major);
    let minorVersion = parseInt(minor);
    return majorVersion === 1 && minorVersion >= 38 && minorVersion < 40;
}

/** assumes docker is on the host's execution path */
class RustPlugin {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.servicePath = this.serverless.config.servicePath || "";
        this.hooks = {
            "before:package:createDeploymentArtifacts": this.build.bind(this),
            "before:deploy:function:packageFunction": this.build.bind(this),
            "after:deploy:function:packageFunction": this.clean.bind(this)
        };
        if (includeInvokeHook(serverless.version)) {
            this.hooks["before:invoke:local:invoke"] = this.build.bind(this);
        }
        this.custom = Object.assign({
                cargoFlags: "",
            },
            (this.serverless.service.custom && this.serverless.service.custom.rust) || {}
        );

        // By default, Serverless examines node_modules to figure out which
        // packages there are from dependencies versus devDependencies of a
        // package. While there will always be a node_modules due to Serverless
        // and this plugin being installed, it will be excluded anyway.
        // Therefore, the filtering can be disabled to speed up (~3.2s) the process.
        this.serverless.service.package.excludeDevDependencies = false;
    }

    runCargo(funcArgs, cargoPackage, binary, profile) {

        this.serverless.cli.log(
            `Running Carego release build.`
        );

        return spawnSync(
            'cargo',
            ['build',
                '--release',
                '--target',
                'x86_64-unknown-linux-musl'
            ], NO_OUTPUT_CAPTURE
        );
    }

    functions() {
        if (this.options.function) {
            return [this.options.function];
        } else {
            return this.serverless.service.getAllFunctions();
        }
    }

    renameBin(profile, binary) {

        const targetPath = `target/x86_64-unknown-linux-musl/${"dev" === profile ? "debug" : "release"}`;
        const binPath = path.join(targetPath, binary);

        // spawnSync(
        //     "cp",
        //     [binPath, `${targetPath}/bootstrap`], NO_OUTPUT_CAPTURE);

        // this.serverless.cli.log(`Will write ${targetPath}/bootstrap files to ${binPath}.zip`);

        // const zipResults = spawnSync('/usr/bin/zip', ['-j', `${binPath}.zip`, `${targetPath}/bootstrap`], NO_OUTPUT_CAPTURE);
        // if (zipResults.status != 0) {
        //     this.serverless.cli.log(`Error while running "zip":`);
        //     this.serverless.cli.log(util.inspect(zipResults))
        //     return;
        // }

        let res = {
            error: null
        };

        let zip = new AdmZip();
        zip.addFile("bootstrap", fs.readFileSync(binPath), '', '755')
        zip.writeZip(`${binPath}.zip`, (error) => {
            if (error) {
                res.error = error
                return;
            }
        });

        this.serverless.cli.log(zip.getEntries());

        return res;
    }



    build() {
        const service = this.serverless.service;
        if (service.provider.name != "aws") {
            return;
        }
        let rustFunctionsFound = false;
        this.functions().forEach(funcName => {
            const func = service.getFunction(funcName);
            const runtime = func.runtime || service.provider.runtime;
            if (runtime != RUST_RUNTIME) {
                // skip functions which don't apply to rust
                return;
            }
            rustFunctionsFound = true;
            let [cargoPackage, binary] = func.handler.split(".");
            if (binary == undefined) {
                binary = cargoPackage;
            }
            this.serverless.cli.log(`Building native Rust ${func.handler} func...`);
            let profile = (func.rust || {}).profile || this.custom.profile;

            const res = this.runCargo(func.rust, cargoPackage, binary, profile);

            if (res.error || res.status > 0) {
                this.serverless.cli.log(
                    `Rust build encountered an error: ${res.error} ${res.status}.`
                );
                throw new Error(res.error);
            }

            const zipResult = this.renameBin(profile, binary)
            if (zipResult.error) {
                this.serverless.cli.log(
                    `Package rust binary failed: ${zipResult.error}.`
                );
                throw new Error(res.error);
            }


            // If all went well, we should now have find a packaged compiled binary under `target/lambda/release`.
            //
            // The AWS "provided" lambda runtime requires executables to be named
            // "bootstrap" -- https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
            //
            // To avoid artifact nameing conflicts when we potentially have more than one function
            // we leverage the ability to declare a package artifact directly
            // see https://serverless.com/framework/docs/providers/aws/guide/packaging/
            // for more information
            const artifactPath = path.join(
                `target/x86_64-unknown-linux-musl/${"dev" === profile ? "debug" : "release"}`,
                binary + ".zip"
            );
            func.package = func.package || {};
            func.package.artifact = artifactPath;

            // Ensure the runtime is set to a sane value for other plugins
            if (func.runtime == RUST_RUNTIME) {
                func.runtime = BASE_RUNTIME;
            }
        });
        if (service.provider.runtime === RUST_RUNTIME) {
            service.provider.runtime = BASE_RUNTIME;
        }
        if (!rustFunctionsFound) {
            throw new Error(
                `Error: no Rust functions found. ` +
                `Use 'runtime: ${RUST_RUNTIME}' in global or ` +
                `function configuration to use this plugin.`
            );
        }
    }

    clean() {
        this.serverless.cli.log(
            `Deleting package files.`
        );

        const service = this.serverless.service;
        if (service.provider.name != "aws") {
            return;
        }

        this.functions().forEach(funcName => {
            const func = service.getFunction(funcName);
            let [cargoPackage, binary] = func.handler.split(".");
            if (binary == undefined) {
                binary = cargoPackage;
            }

            const targetPath = `target/x86_64-unknown-linux-musl/${"dev" === profile ? "debug" : "release"}`;
            const res = fs.unlinkSync(`${targetPath}/bootstrap`);
            if (res.error || res.status > 0) {
                this.serverless.cli.log(
                    `Cannot delete ${targetPath}/bootstrap: ${res.error} ${res.status}.`
                );
                throw new Error(res.error);
            }
            const res2 = fs.unlinkSync(`${targetPath}/${binary}.zip`);
            if (res2.error || res2.status > 0) {
                this.serverless.cli.log(
                    `Cannot delete ${targetPath}/${binary}.zip: ${res2.error} ${res2.status}.`
                );
                throw new Error(res.error);
            }
        });
    }
}

module.exports = RustPlugin;