import debug from 'debug';

const debugInternal = debug('bidiMapper:internal');
const debugSend = debug('bidiMapper:SEND ►');
const debugRecv = debug('bidiMapper:RECV ◀');
const debugLog = debug('bidiMapper:log');

import { IServer } from './iServer';
import WebSocket from 'ws';

export class MapperServer implements IServer {
    private _handlers: ((messageObj: any) => void)[] = new Array()
    private _commandCallbacks: ((messageObj: any) => void)[] = new Array()
    private _ws: WebSocket
    private _mapperSessionId;

    static async create(cdpUrl: string, mapperContent: string): Promise<MapperServer> {
        const mapper = new MapperServer;
        await mapper._establishCdpSession(cdpUrl);
        await mapper._initMapper(mapperContent);
        return mapper;
    }

    setOnMessage(handler: (messageObj: any) => void): void {
        this._handlers.push(handler);
    }
    sendMessage(messageObj: string): Promise<void> {
        return this._sendBidiMessage(messageObj);
    }

    private _establishCdpSession: (cdpUrl: string) => Promise<void> = async function (cdpUrl: string) {
        return new Promise(resolve => {
            debugInternal("Establishing session with cdpUrl: ", cdpUrl);

            this._ws = new WebSocket(cdpUrl);

            this._ws.on('message', (dataStr: string) => {
                this._onCdpMessage(dataStr);
            });

            this._ws.on('open', () => {
                debugInternal("Session established.");
                resolve();
            });
        });
    };

    private _sendBidiMessage(bidiMessageObj: any): Promise<void> {
        return this._sendCdpCommand({
            method: "Runtime.evaluate",
            sessionId: this._mapperSessionId,
            params: {
                expression: "onBidiMessage(" + JSON.stringify(bidiMessageObj) + ")"
            }
        });
    }

    private _onBidiMessage(bidiMessageObj: any): void {
        for (let handler of this._handlers)
            handler(bidiMessageObj);
    }

    private _onCdpMessage(dataStr: string): void {
        const data = JSON.parse(dataStr);
        debugRecv(data);
        if (this._commandCallbacks.hasOwnProperty(data.id)) {
            this._commandCallbacks[data.id](data.result);
            return;
        } else {
            if (data.method === "Runtime.bindingCalled" && data.params && data.params.name === "sendBidiResponse") {
                this._onBidiMessage(data.params.payload);
                return;
            }
            if (data.method === "Runtime.consoleAPICalled") {
                debugLog.apply(null, data.params.args.map(arg=>arg.value));
                return;
            }
        }
    }

    private async _sendCdpCommand(command: any): Promise<any> {
        return new Promise((resolve) => {
            const id = this._commandCallbacks.length;
            this._commandCallbacks[id] = resolve;
            command.id = id;
            debugSend(command);
            this._ws.send(JSON.stringify(command));
        });
    };

    private async _initMapper(mapperContent: string): Promise<void> {
        debugInternal("Connection opened.");

        // await this._sendCdpCommand({
        //     method: "Log.enable"
        // })

        const targetId = (
            await this._sendCdpCommand({
                method: "Target.createTarget",
                params: {
                    url: "about:blank"
                }
            })).targetId;

        this._mapperSessionId = (await this._sendCdpCommand({
            "method": "Target.attachToTarget",
            "params": {
                "targetId": targetId,
                "flatten": true
            }
        })).sessionId;

        await this._sendCdpCommand({
            method: "Runtime.enable",
            sessionId: this._mapperSessionId
        })


        await this._sendCdpCommand({
            method: "Target.exposeDevToolsProtocol",
            params: {
                bindingName: "cdp",
                targetId
            }
        });

        await this._sendCdpCommand({
            method: "Runtime.addBinding",
            sessionId: this._mapperSessionId,
            params: {
                name: "sendBidiResponse"
            }
        });

        await this._sendCdpCommand({
            method: "Runtime.evaluate",
            sessionId: this._mapperSessionId,
            params: {
                expression: mapperContent
            }
        })

        // Let Mapper know what is it's TargetId to filter out related targets.
        await this._sendCdpCommand({
            method: "Runtime.evaluate",
            sessionId: this._mapperSessionId,
            params: {
                expression: "window.setCurrentTargetId(" + JSON.stringify(targetId) + ")"
            }
        });

        debugInternal("Launched!");
    }
}
