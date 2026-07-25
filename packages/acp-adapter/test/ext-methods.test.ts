import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type {
  KimiHarness,
  Session,
  SessionToolDefinition,
} from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  constructor(
    private readonly onExtMethod?: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) {}

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in ext-methods test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in ext-methods test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in ext-methods test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in ext-methods test');
  }
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.onExtMethod === undefined) {
      throw new Error(`StubClient.extMethod should not be called: ${method}`);
    }
    return this.onExtMethod(method, params);
  }
}

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

function makeMinimalHarness(): KimiHarness {
  // ext_method does not touch the harness; the auth/session surface
  // is irrelevant for these tests so the stub keeps the harness flat.
  return {} as unknown as KimiHarness;
}

describe('AcpServer ext method surface', () => {
  it('unit-level extMethod throws RequestError.methodNotFound with the method name', async () => {
    const server = new AcpServer(makeMinimalHarness());
    await expect(server.extMethod('myorg.foo', {})).rejects.toMatchObject({
      // JSON-RPC method-not-found code per ACP SDK RequestError.methodNotFound.
      code: -32601,
      // RequestError stamps the requested method name into the message
      // so clients can distinguish "ext/foo" from "ext/bar".
      message: expect.stringContaining('myorg.foo'),
    });
  });

  it('unit-level extNotification throws RequestError.methodNotFound with the method name', async () => {
    const server = new AcpServer(makeMinimalHarness());
    await expect(server.extNotification('myorg.bar', {})).rejects.toMatchObject({
      code: -32601,
      message: expect.stringContaining('myorg.bar'),
    });
  });

  it('over-the-wire extMethod surfaces -32601 to a remote ACP client', async () => {
    const harness = makeMinimalHarness();
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.extMethod('myorg.unsupported', {})).rejects.toMatchObject({
      code: -32601,
    });
  });

  it('routes _kimi/session/steer to the active SDK session', async () => {
    const steered: unknown[] = [];
    const session = {
      id: 'sess-steer',
      steer: async (input: unknown) => {
        steered.push(input);
      },
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);
    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.extMethod('_kimi/session/steer', {
        sessionId: session.id,
        prompt: [{ type: 'text', text: 'change direction' }],
      }),
    ).resolves.toEqual({ accepted: true });
    expect(steered).toEqual([[{ type: 'text', text: 'change direction' }]]);
  });

  it('registers host tools and routes their execution back to the ACP client', async () => {
    let registered: SessionToolDefinition | undefined;
    const session = {
      id: 'sess-tools',
      registerTool: async (tool: SessionToolDefinition) => {
        registered = tool;
      },
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;
    const reverseCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(
      (_a) => new StubClient(async (method, params) => {
        reverseCalls.push({ method, params });
        return { output: 'done' };
      }),
      clientStream,
    );
    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.extMethod('_kimi/session/register_tools', {
        sessionId: session.id,
        tools: [{
          name: 'exec_async',
          description: 'Run a background task.',
          parameters: { type: 'object', properties: {} },
        }],
      }),
    ).resolves.toEqual({ registered: ['exec_async'] });

    await expect(registered?.execute({
      name: 'exec_async',
      toolCallId: 'call-1',
      turnId: 7,
      args: { command: 'echo ok' },
    })).resolves.toEqual({ output: 'done' });
    expect(reverseCalls).toEqual([{
      method: '_kimi/tool/call',
      params: {
        sessionId: session.id,
        name: 'exec_async',
        toolCallId: 'call-1',
        turnId: 7,
        args: { command: 'echo ok' },
      },
    }]);
  });
});
