import { env } from "../config/env.js";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let sdk: NodeSDK | undefined;

export async function setupTracing() {
  if (!env.OTEL_ENABLED) return;
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: "saas-orders-api",
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: "orders",
    [SemanticResourceAttributes.SERVICE_VERSION]: "0.1.0",
  });

  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT })
    : new ConsoleSpanExporter();

  sdk = new NodeSDK({ resource, traceExporter: exporter });
  try {
    await Promise.resolve((sdk as NodeSDK).start());
  } catch {
    // ignorar errores de inicio en P0
  }
}

export async function shutdownTracing() {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch {
      // ignore
    }
  }
}
