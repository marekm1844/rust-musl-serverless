[![N|Solid](logo.png)](https://sufrago.com)


# Serverless Plugin - Rust local compile to Lambda


This serverless plugin will compile locally Rust application and deploy it to Lambda. 

It was designed this way because serverless-rust plugin will use Docker image without all necessary libraries ( like MySQL ). 
This plugin will use your local environment to compile Rust application to AWS Lambda target.


## Pre-requirements:
- Serverless installed. 
- Rust Musl target installed: x86_64-unknown-linux-musl.



## Usage
npm -i --save-dev @sufrago/rust-musl-serverless

Add "@sufrago/rust-musl-serverless" plugin to your serverless yaml.


serverless deploy 

## Changelog
- 1.0.2 Use adm-zip library instead OS zip command. 


