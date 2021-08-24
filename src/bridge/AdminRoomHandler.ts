/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { BridgeRequest } from "../models/BridgeRequest";
import { MatrixRoom, MatrixUser } from "matrix-appservice-bridge";
import { IrcBridge } from "./IrcBridge";
import { MatrixAction } from "../models/MatrixAction";
import { IrcServer } from "../irc/IrcServer";
import { BridgedClient } from "../irc/BridgedClient";
import { IrcClientConfig } from "../models/IrcClientConfig";
import { MatrixHandler, MatrixSimpleMessage } from "./MatrixHandler";
import logging from "../logging";
import * as RoomCreation from "./RoomCreation";
import { getBridgeVersion } from "../util/PackageInfo";
import { ProvisionRequest } from "../provisioning/ProvisionRequest";
import { IdentGenerator } from "../irc/IdentGenerator";

const log = logging("AdminRoomHandler");

// This is just a length to avoid silly long usernames
const SANE_USERNAME_LENGTH = 64;

interface Command {
    example: string;
    summary: string;
    requiresPermission?: string;
}

interface Heading {
    heading: true;
}

const COMMANDS: {[command: string]: Command|Heading} = {
    'Actions': { heading: true },
    "!cmd": {
        example: `!cmd [irc.example.net] COMMAND [arg0 [arg1 [...]]]`,
        summary: "Issue a raw IRC command. These will not produce a reply." +
                "(Note that the command must be all uppercase.)",
    },
    "!feature": {
        example: `!feature feature-name [true/false/default]`,
        summary: `Enable, disable or default a feature's status for your account.` +
                `Will display the current feature status if true/false/default not given.`,
    },
    "!join": {
        example: `!join [irc.example.net] #channel [key]`,
        summary: `Join a channel (with optional channel key)`,
    },
    "!nick": {
        example: `!nick [irc.example.net] DesiredNick`,
        summary: "Change your nick. If no arguments are supplied, " +
                "your current nick is shown.",
    },
    "!quit": {
        example: `!quit`,
        summary: "Leave all bridged channels, on all networks, and remove your " +
                "connections to all networks.",
    },
    'Authentication': { heading: true },
    "!storepass": {
        example: `!storepass [irc.example.net] passw0rd`,
        summary: `Store a NickServ OR SASL password (server password)`,
    },
    "!reconnect": {
        example: `!reconnect [irc.example.net]`,
        summary: "Reconnect to an IRC network.",
    },
    "!removepass": {
        example: `!removepass [irc.example.net]`,
        summary: `Remove a previously stored NickServ password`,
    },
    "!username": {
        example: `!username [irc.example.net] username`,
        summary: "Store a username to use for future connections.",
    },
    'Info': { heading: true},
    "!bridgeversion": {
        example: `!bridgeversion`,
        summary: "Return the version from matrix-appservice-irc bridge.",
    },
    "!listrooms": {
        example: `!listrooms [irc.example.net]`,
        summary: "List all of your joined channels, and the rooms they are bridged into.",
    },
    "!whois": {
        example: `!whois [irc.example.net] NickName|@alice:matrix.org`,
        summary: "Do a /whois lookup. If a Matrix User ID is supplied, " +
                "return information about that user's IRC connection.",
    },
    'Management': { heading: true },
    '!plumb': {
        example: `!plumb !room:example.com irc.example.net #foobar`,
        summary: "Plumb an IRC channel into a Matrix room.",
        requiresPermission: 'admin'
    },
    '!unlink': {
        example: "!unlink !room:example.com irc.example.net #foobar",
        summary: "Unlink an IRC channel from a Matrix room. " +
                "You need to be a moderator of the Matrix room or an administrator of this bridge.",
    },
};

class ServerRequiredError extends Error {
    notice = new MatrixAction("notice", "A server address must be specified.");
}

const USER_FEATURES = ["mentions"];
export class AdminRoomHandler {
    private readonly botUser: MatrixUser;
    constructor(private ircBridge: IrcBridge, private matrixHandler: MatrixHandler) {
        this.botUser = new MatrixUser(ircBridge.appServiceUserId, undefined, false);
    }

    public async onAdminMessage(req: BridgeRequest, event: MatrixSimpleMessage, adminRoom: MatrixRoom) {
        req.log.info("Handling command from %s", event.sender);
        // Assumes all commands have the form "!wxyz [irc.server] [args...]"
        const segments = event.content.body.split(" ");
        const [cmd, ...args] = segments;

        let response: MatrixAction|void;
        try {
            response = await this.handleCommand(cmd, args, req, event);
        }
        catch (err) {
            if (err instanceof ServerRequiredError) {
                response = err.notice;
            }
            else {
                req.log.error("Exception while handling command %s from %s: %s", cmd, event.sender, err);
                response = new MatrixAction("notice", "An unknown error happened while handling your command");
            }
        }

        if (response) {
            response.replyEvent = event.event_id;
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, response);
        }
    }

    private async handleCommand(cmd: string, args: string[], req: BridgeRequest, event: MatrixSimpleMessage) {
        switch (cmd) {
            case "!join":
                return await this.handleJoin(req, args, event.sender);
            case "!cmd":
                return await this.handleCmd(req, args, event.sender);
            case "!whois":
                return await this.handleWhois(req, args, event.sender);
            case "!reconnect":
                return await this.handleReconnect(req, args, event.sender);
            case "!username":
                return await this.handleUsername(req, args, event.sender)
            case "!storepass":
                return await this.handleStorePass(req, args, event.sender);
            case "!removepass":
                return await this.handleRemovePass(args, event.sender);
            case "!listrooms":
                return await this.handleListRooms(args, event.sender);
            case "!quit":
                return await this.handleQuit(req, event.sender, args);
            case "!nick":
                return await this.handleNick(req, args, event.sender);
            case "!feature":
                return await this.handleFeature(args, event.sender);
            case "!bridgeversion":
                return this.showBridgeVersion();
            case "!plumb":
                return await this.handlePlumb(args, event.sender)
            case "!unlink":
            case "!unplumb": // alias for convinience
                return await this.handleUnlink(args, event.sender)
            case "!help":
                return this.showHelp(event.sender);
            default: {
                return new MatrixAction("notice",
                    "The command was not recognised. Available commands are listed by !help");
            }
        }
    }

    private async handlePlumb(args: string[], sender: string) {
        const userPermission = this.getUserPermission(sender);
        if (userPermission !== 'admin') {
            return new MatrixAction("notice", "You must be an admin to use this command");
        }
        const [matrixRoomId, serverDomain, ircChannel] = args;
        const server = serverDomain && this.ircBridge.getServer(serverDomain);
        if (!server) {
            return new MatrixAction("notice", "The server provided is not configured on this bridge");
        }
        // Check if the room exists and the user is invited.
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        try {
            await intent.getStateEvent(matrixRoomId, 'm.room.create');
        }
        catch (ex) {
            log.error(`Could not join the target room of a !plumb command`, ex);
            return new MatrixAction("notice", "Could not join the target room, you may need to invite the bot");
        }
        try {
            await this.ircBridge.getProvisioner().doLink(
                ProvisionRequest.createFake("adminCommand", log),
                server,
                ircChannel,
                undefined,
                matrixRoomId,
                sender,
            );
        }
        catch (ex) {
            log.error(`Failed to handle !plumb command:`, ex);
            return new MatrixAction("notice", "Failed to plumb room. Check the logs for details.");
        }
        return new MatrixAction("notice", "Room plumbed.");
    }

    private async handleUnlink(args: string[], sender: string) {
        const userPermission = this.getUserPermission(sender);
        const [matrixRoomId, serverDomain, ircChannel] = args;
        const server = serverDomain && this.ircBridge.getServer(serverDomain);
        if (!server) {
            return new MatrixAction("notice", "The server provided is not configured on this bridge");
        }
        try {
            await this.ircBridge.getProvisioner().unlink(
                ProvisionRequest.createFake("adminCommand", log,
                    {
                        remote_room_server: serverDomain,
                        remote_room_channel: ircChannel,
                        matrix_room_id: matrixRoomId,
                        user_id: sender,
                    },
                ),
                userPermission === "admin"
            );
        }
        catch (ex) {
            log.error(`Failed to handle !unlink command:`, ex);
            return new MatrixAction("notice", "Failed to unlink room. Check the logs for details.");
        }
        return new MatrixAction("notice", "Room unlinked.");
    }

    private async handleJoin(req: BridgeRequest, args: string[], sender: string) {
        const server = this.extractServerFromArgs(args);
        // check that the server exists and that the user_id is on the whitelist
        const ircChannel = args[0];
        const key = args[1]; // keys can't have spaces in them, so we can just do this.
        let errText = null;
        if (!ircChannel) {
            errText = "Format: '!join irc.blasehase.de #channel [key]'";
        }
        else if (!server.canJoinRooms(sender)) {
            errText = "You are not authorised to join channels on this server.";
        }

        if (errText) {
            return new MatrixAction("notice", errText);
        }
        req.log.info("%s wants to join the channel %s on %s", sender, ircChannel, server.domain);

        // There are 2 main flows here:
        //   - The !join is instigated to make the BOT join a new channel.
        //        * Bot MUST join and invite user
        //   - The !join is instigated to make the USER join a new channel.
        //        * IRC User MAY have to join (if bridging incr joins or using a chan key)
        //        * Bot MAY invite user
        //
        // This means that in both cases:
        //  1) Bot joins IRC side (NOP if bot is disabled)
        //  2) Bot sends Matrix invite to bridged room. (ignore failures if already in room)
        // And *sometimes* we will:
        //  3) Force join the IRC user (if given key / bridging joins)

        // track the channel if we aren't already
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            server, ircChannel
        );

	matrixRooms.forEach(item => {
            req.log.info("Blahblahblah %s", item)
        });

        if (matrixRooms.length <= 1) {
            // track the channel then invite them.
            const { ircRoom, mxRoom } = await RoomCreation.trackChannelAndCreateRoom(this.ircBridge, req, {
                origin: "join",
                server: server,
                ircChannel,
                key,
                inviteList: [sender],
            });
            req.log.info(
                "Created a room to track %s on %s and invited %s",
                ircRoom.channel, server.domain, sender
            );
            matrixRooms.push(mxRoom);
        }
        else {
            // already tracking channel, so just invite them.
            await Promise.all(matrixRooms.map(async (r) => {
                req.log.info(
                    "Inviting %s to room %s", sender, r.getId()
                );
                try {
                    await this.ircBridge.getAppServiceBridge().getIntent().invite(
                        r.getId(), sender
                    );
                }
                catch (ex) {
                    log.warn(`Failed to invite ${sender} to ${r.getId()}:`, ex);
                }
            }));
        }
        // check whether we should be force joining the IRC user
        for (let i = 0; i < matrixRooms.length; i++) {
            const m = matrixRooms[i];
            const userMustJoin = (
                key ?? server.shouldSyncMembershipToIrc("incremental", m.getId())
            );
            if (userMustJoin) {
                // force join then break out (we only ever join once no matter how many
                // rooms the channel is bridged to)
                const bc = await this.ircBridge.getBridgedClient(
                    server, sender
                );
                await bc.joinChannel(ircChannel, key);
                break;
            }
        }
        return undefined;
    }

    private async handleCmd(req: BridgeRequest, args: string[], sender: string) {
        req.log.info(`No valid (old form) admin command, will try new format`);

        // Assumes commands have the form
        // !cmd [irc.server] COMMAND [arg0 [arg1 [...]]]
        const server = this.extractServerFromArgs(args);

        const blacklist = ['PROTOCTL'];

        try {
            const keyword = args[0];

            // keyword could be a failed server or a malformed command
            if (!keyword.match(/^[A-Z]+$/)) {
                // if not a domain OR is only word (which implies command)
                if (!keyword.match(/^[a-z0-9:\.-]+$/) || args.length === 1) {
                    throw new Error(`Malformed command: ${keyword}`);
                }
                else {
                    throw new Error(`Domain not accepted: ${keyword}`);
                }
            }

            if (blacklist.includes(keyword)) {
                throw new Error(`Command blacklisted: ${keyword}`);
            }

            // If no args after COMMAND, this will be []
            const sendArgs = args.splice(1);
            sendArgs.unshift(keyword);

            const bridgedClient = await this.ircBridge.getBridgedClient(
                server, sender
            );

            bridgedClient.sendCommands(...sendArgs);
        }
        catch (err) {
            return new MatrixAction("notice", `${err}\n` );
        }
        return undefined;
    }

    private async handleWhois(req: BridgeRequest, args: string[], sender: string) {
        const server = this.extractServerFromArgs(args);

        // Format is: "!whois <nick>"
        const whoisNick = args.length === 1 ? args[0] : null; // ensure 1 arg
        if (!whoisNick) {
            return new MatrixAction("notice", "Format: '!whois nick|mxid'");
        }

        if (whoisNick[0] === "@") {
            // querying a Matrix user - whoisNick is the matrix user ID
            req.log.info("%s wants whois info on %s", sender, whoisNick);
            const whoisClient = this.ircBridge.getIrcUserFromCache(server, whoisNick);
            try {
                return new MatrixAction(
                    "notice",
                    whoisClient ?
                        `${whoisNick} is connected to ${server.domain} as '${whoisClient.nick}'.` :
                        `${whoisNick} has no IRC connection via this bridge.`);
            }
            catch (err) {
                if (err.stack) {
                    req.log.error(err);
                }
                return new MatrixAction("notice", "Failed to perform whois query.");
            }
        }

        req.log.info("%s wants whois info on %s on %s", sender,
            whoisNick, server.domain);
        const bridgedClient = await this.ircBridge.getBridgedClient(server, sender);
        try {
            const response = await bridgedClient.whois(whoisNick);
            return new MatrixAction("notice", response?.msg || "User not found");
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            return new MatrixAction("notice", err.message);
        }
    }

    private async handleReconnect(req: BridgeRequest, args: string[], userId: string) {
        const server = this.extractServerFromArgs(args);
        const clientList = this.getClientList(userId);

        const client = clientList.find((c) => c.server.domain === server.domain);
        try {
            if (client) {
                await client.disconnect("iwanttoreconnect", "Reconnecting", false);
                return new MatrixAction(
                    "notice", `Reconnecting to network...`
                );
            }
            return new MatrixAction(
                "notice", `No clients connected to this network, not reconnecting`
            );
        }
        catch (err) {
            req.log.error(err.stack);
            return new MatrixAction(
                "notice", `Failed to reconnect`
            );
        }
    }

    private async handleUsername(req: BridgeRequest, args: string[], userId: string) {
        const server = this.extractServerFromArgs(args);

        const domain = server.domain;
        const store = this.ircBridge.getStore();
        let notice;

        try {
            // Allow passwords with spaces
            const username = args[0]?.trim();
            if (!username) {
                notice = new MatrixAction(
                    "notice",
                    "Format: '!username username' " +
                    "or '!username irc.server.name username'\n"
                );
            }
            else if (username.length > SANE_USERNAME_LENGTH) {
                notice = new MatrixAction(
                    "notice",
                    `Username is longer than the maximum permitted by the bridge (${SANE_USERNAME_LENGTH}).`
                );
            }
            else if (IdentGenerator.sanitiseUsername(username) !== username) {
                notice = new MatrixAction(
                    "notice",
                    `Username contained invalid characters not supported by IRC.`
                );
            }
            else {
                let config = await store.getIrcClientConfig(userId, server.domain);
                if (!config) {
                    config = IrcClientConfig.newConfig(
                        new MatrixUser(userId), server.domain
                    );
                }
                config.setUsername(username);
                await this.ircBridge.getStore().storeIrcClientConfig(config);
                notice = new MatrixAction(
                    "notice", `Successfully stored username for ${domain}. Use !reconnect to use this username now.`
                );
            }
        }
        catch (err) {
            req.log.error(err.stack);
            return new MatrixAction(
                "notice", `Failed to store username: ${err.message}`
            );
        }
        return notice;

    }

    private async handleStorePass(req: BridgeRequest, args: string[], userId: string) {
        const server = this.extractServerFromArgs(args);

        const domain = server.domain;
        let notice;

        try {
            // Allow passwords with spaces
            const pass = args.join(' ');
            if (pass.length === 0) {
                notice = new MatrixAction(
                    "notice",
                    "Format: '!storepass password' or '!storepass irc.server.name password'\n"
                );
            }
            else {
                await this.ircBridge.getStore().storePass(userId, domain, pass);
                notice = new MatrixAction(
                    "notice", `Successfully stored password for ${domain}. Use !reconnect to use this password now.`
                );
            }
        }
        catch (err) {
            req.log.error(err.stack);
            return new MatrixAction(
                "notice", `Failed to store password: ${err.message}`
            );
        }
        return notice;
    }

    private async handleRemovePass(args: string[], userId: string) {
        const ircServer = this.extractServerFromArgs(args);

        const domain = ircServer.domain;

        try {
            await this.ircBridge.getStore().removePass(userId, domain);
            return new MatrixAction(
                "notice", `Successfully removed password.`
            );
        }
        catch (err) {
            return new MatrixAction(
                "notice", `Failed to remove password: ${err.message}`
            );
        }
    }

    private async handleListRooms(args: string[], sender: string) {
        const server = this.extractServerFromArgs(args);

        const client = this.ircBridge.getIrcUserFromCache(server, sender);
        if (!client || client.isDead()) {
            return new MatrixAction(
                "notice", "You are not currently connected to this irc network"
            );
        }
        if (client.chanList.size === 0) {
            return new MatrixAction(
                "notice", "You are connected, but not joined to any channels."
            );
        }

        let chanList = `You are joined to ${client.chanList.size} rooms: \n\n`;
        let chanListHTML = `<p>You are joined to <code>${client.chanList.size}</code> rooms:</p><ul>`;
        for (const channel of client.chanList) {
            const rooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
            chanList += `- \`${channel}\` which is bridged to ${rooms.map((r) => r.getId()).join(", ")}`;
            const roomMentions = rooms
                .map((r) => `<a href="https://matrix.to/#/${r.getId()}">${r.getId()}</a>`)
                .join(", ");
            chanListHTML += `<li><code>${channel}</code> which is bridged to ${roomMentions} </li>`
        }
        chanListHTML += "</ul>"

        return new MatrixAction(
            "notice", chanList, chanListHTML
        );
    }

    private async handleQuit(req: BridgeRequest, sender: string, args: string[]) {
        const server = this.extractServerFromArgs(args);
        const clients = this.getClientList(sender);
        const msgText = await this.matrixHandler.quitUser(
            req, sender, clients, server, "issued !quit command"
        );
        return msgText ? new MatrixAction("notice", msgText) : undefined;
    }

    private async handleNick(req: BridgeRequest, args: string[], sender: string) {
        const ircServer = this.extractServerFromArgs(args);
        const clientList = this.getClientList(sender);

        // Format is: "!nick irc.example.com NewNick"
        if (!ircServer.allowsNickChanges()) {
            return new MatrixAction("notice",
                "Server " + ircServer.domain + " does not allow nick changes."
            );
        }

        const nick = args.length === 1 ? args[0] : null; // make sure they only gave 1 arg
        if (!ircServer || !nick) {
            let connectedNetworksStr = "";
            if (clientList.length === 0) {
                connectedNetworksStr = (
                    "You are not currently connected to any " +
                    "IRC networks which have nick changes enabled."
                );
            }
            else {
                connectedNetworksStr = "Currently connected to IRC networks:\n";
                for (let i = 0; i < clientList.length; i++) {
                    connectedNetworksStr += clientList[i].server.domain +
                        " as " + clientList[i].nick + "\n";
                }
            }
            return new MatrixAction("notice",
                "Format: '!nick DesiredNick' or '!nick irc.server.name DesiredNick'\n" +
                connectedNetworksStr
            );
        }
        req.log.info("%s wants to change their nick on %s to %s",
            sender, ircServer.domain, nick);

        if (ircServer.claimsUserId(sender)) {
            req.log.error("%s is a virtual user!", sender);
            return undefined;
        }

        // change the nick
        const bridgedClient = await this.ircBridge.getBridgedClient(ircServer, sender);
        let notice;
        try {
            if (bridgedClient) {
                const response = await bridgedClient.changeNick(nick, true);
                notice = new MatrixAction("notice", response);
            }
            // persist this desired nick
            let config = await this.ircBridge.getStore().getIrcClientConfig(
                sender, ircServer.domain
            );
            if (!config) {
                config = IrcClientConfig.newConfig(
                    new MatrixUser(sender), ircServer.domain, nick
                );
            }
            config.setDesiredNick(nick);
            await this.ircBridge.getStore().storeIrcClientConfig(config);
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            return new MatrixAction("notice", err.message);
        }
        return notice;
    }

    private async handleFeature(args: string[], sender: string) {
        if (args.length === 0 || !USER_FEATURES.includes(args[0].toLowerCase())) {
            return new MatrixAction("notice",
                "Missing or unknown feature flag. Must be one of: " + USER_FEATURES.join(", ")
            );
        }
        const featureFlag = args[0];
        const features = await this.ircBridge.getStore().getUserFeatures(sender);
        if (!args[1]) {
            const val = features[featureFlag];
            let msg = `'${featureFlag}' is `;
            if (val === true) {
                msg += "enabled.";
            }
            else if (val === false) {
                msg += "disabled.";
            }
            else {
                msg += "set to the default value.";
            }
            return new MatrixAction("notice", msg);
        }
        if (!["true", "false", "default"].includes(args[1].toLowerCase())) {
            return new MatrixAction("notice",
                "Parameter must be either true, false or default."
            );
        }
        features[featureFlag] = args[1] === "default" ? undefined :
            args[1].toLowerCase() === "true";

        await this.ircBridge.getStore().storeUserFeatures(sender, features);
        let note = "";
        if (featureFlag === "mentions") {
            // We should invalidate caching for this user's channels.
            if (!this.ircBridge.ircHandler.invalidateCachingForUserId(sender)) {
                note = " This bridge has disabled mentions, so this flag will do nothing.";
            }
        }
        return new MatrixAction("notice",
            `Set ${featureFlag} to ${features[featureFlag]}.${note}`
        );
    }

    private showBridgeVersion() {
        return new MatrixAction("notice", `BridgeVersion: ${getBridgeVersion()}`);
    }

    private showHelp(userPermission: string|undefined): MatrixAction {
        let body = "This is an IRC admin room for controlling your IRC connection and sending " +
        "commands directly to IRC.<br/>" +
        "See the <a href=\"https://matrix-org.github.io/matrix-appservice-irc/latest/usage.html\">" +
        "Matrix IRC Bridge Usage Guide</a> on how to control the IRC bridge using this room.<br/>" +
        "The following commands are available:<br/><ul>";
        for (const [key, command] of Object.entries(COMMANDS)) {
            if ("heading" in command) {
                body += `</ul>\n<h3>${key}</h3>\n<ul>`;
                continue;
            }
            if (!command.requiresPermission || command.requiresPermission === userPermission) {
                body += `<li><strong>${command.example}</strong> : ${command.summary}</li>\n\t`;
            }
        }
        return new MatrixAction("notice", null, body + "</ul>");
    }

    // will mutate args if sucessful
    private extractServerFromArgs(args: string[]): IrcServer {
        // Require an IRC server to be specified if there's more than one possible choice
        let ircServer = this.ircBridge.getServer(args[0]);
        if (ircServer) {
            args.shift(); // we'll be passing it to command handlers separately
        }
        else if (this.ircBridge.getServers().length === 1) {
            ircServer = this.ircBridge.getServers()[0];
        }
        else {
            throw new ServerRequiredError();
        }

        return ircServer;
    }

    private getClientList(userId: string): BridgedClient[] {
        return this.ircBridge.getBridgedClientsForUserId(userId);
    }

    private getUserPermission(userId: string): string|undefined {
        const userDomain = userId.split(':')[1];

        return this.ircBridge.config.ircService.permissions &&
               (this.ircBridge.config.ircService.permissions[userId] || // This takes priority
               this.ircBridge.config.ircService.permissions[userDomain] || // Then the domain
               this.ircBridge.config.ircService.permissions['*']); // Finally wildcard.
    }
}
