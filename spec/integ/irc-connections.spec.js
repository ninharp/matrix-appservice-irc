/*
 * Tests IRC connections are managed correctly.
 */
const Promise = require("bluebird");

const envBundle = require("../util/env-bundle");

describe("IRC connections", function() {

    let testUser = {
        id: "@alice:hs",
        nick: "M-alice"
    };

    const {env, config, roomMapping, test} = envBundle();
    // Ensure the right users are excluded.
    Object.values(config.ircService.servers)[0].excludedUsers = [
        {
            regex: "@excluded:hs",
        }
    ];

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        // make the bot automatically connect and join the mapped channel
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        // do the init
        yield test.initEnv(env, config);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should use the matrix user's display name if they have one",
    function(done) {
        let displayName = "Some_Name";
        let nickForDisplayName = "M-Some_Name";

        // not interested in join calls
        env.ircMock._autoJoinChannels(
            roomMapping.server, nickForDisplayName, roomMapping.channel
        );

        // listen for the display name nick and let it connect
        let gotConnectCall = false;
        env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "connect",
        function(client, cb) {
            gotConnectCall = true;
            client._invokeCallback(cb);
        });

        // also listen for the normal nick so we can whine more coherently
        // rather than just time out the test.
        env.ircMock._whenClient(roomMapping.server, testUser.nick, "connect",
        function(client, cb) {
            console.error("Wrong nick connected: %s", testUser.nick);
            client._invokeCallback(cb);
        });

        // mock a response for the state event.
        env.clientMock._client(config._botUserId).getStateEvent.and.callFake(function() {
            return Promise.resolve({
                displayname: displayName
            });
        });

        let gotSayCall = false;
        env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(nickForDisplayName);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            gotSayCall = true;
        });

        // send a message to kick start the AS
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            expect(gotConnectCall).toBe(
                true, nickForDisplayName + " failed to connect to IRC."
            );
            expect(gotSayCall).toBe(true, "Didn't get say");
            done();
        });
    });

    it("should coerce invalid nicks into a valid form", function(done) {
        let displayName = "123Num£Ber";
        let nickForDisplayName = "M-123NumBer";

        // not interested in join calls
        env.ircMock._autoJoinChannels(
            roomMapping.server, nickForDisplayName, roomMapping.channel
        );

        // listen for the display name nick and let it connect
        let gotConnectCall = false;
        env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "connect",
        function(client, cb) {
            gotConnectCall = true;
            client._invokeCallback(cb);
        });

        // also listen for the normal nick so we can whine more coherently
        // rather than just time out the test.
        env.ircMock._whenClient(roomMapping.server, testUser.nick, "connect",
        function(client, cb) {
            console.error("Wrong nick connected: %s", testUser.nick);
            client._invokeCallback(cb);
        });

        // mock a response for the state event.
        env.clientMock._client(config._botUserId).getStateEvent.and.callFake(function() {
            return Promise.resolve({
                displayname: displayName
            });
        });

        let gotSayCall = false;
        env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(nickForDisplayName);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            gotSayCall = true;
        });

        // send a message to kick start the AS
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            expect(gotConnectCall).toBe(
                true, nickForDisplayName + " failed to connect to IRC."
            );
            expect(gotSayCall).toBe(true, "Didn't get say");
            done();
        });
    });

    it("should use the nick assigned in the rpl_welcome (registered) event",
    function(done) {
        let assignedNick = "monkeys";

        // catch attempts to send messages and fail coherently
        let sdk = env.clientMock._client(config._botUserId);
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + testUser.nick,
            returnUserId: testUser.id
        });
        sdk.sendEvent.and.callFake(function(roomId, type, c) {
            expect(false).toBe(
                true, "bridge tried to send a msg to matrix from a virtual " +
                "irc user with a nick assigned from rpl_welcome."
            );
            done();
            return Promise.resolve();
        });

        // let the user connect
        env.ircMock._whenClient(roomMapping.server, testUser.nick, "connect",
        function(client, cb) {
            // cb fires *AFTER* the 'registered' event. The 'registered' event
            // fires on receipt of rpl_welcome which may modify the underlying nick.
            // Change the nick and then invoke the callback.
            process.nextTick(function() {
                client.nick = assignedNick;
                process.nextTick(function() {
                    cb();
                });
            });
        });

        // we're not interested in the joins, so autojoin them.
        env.ircMock._autoJoinChannels(
            roomMapping.server, assignedNick, roomMapping.channel
        );

        // send a message from matrix to make them join the room.
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            // send a message in response from the assigned nick: if it is using
            // the assigned nick then it shouldn't try to pass it on (virtual
            // user error)
            env.ircMock._findClientAsync(
                roomMapping.server, roomMapping.botNick
            ).then(function(client) {
                client.emit(
                    "message", assignedNick, roomMapping.channel, "some text"
                );
                // TODO: We should really have a means to notify tests if the
                // bridge decides to do nothing due to it being an ignored user.
                setTimeout(function() {
                    done();
                }, 200);
            });
        });
    });

    it("should be made once per client, regardless of how many messages are " +
    "to be sent to IRC", async function() {
        let connectCount = 0;

        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "connect", (client, cb) => {
            connectCount += 1;
            // add an artificially long delay to make sure it isn't connecting
            // twice
            setTimeout(function() {
                client._invokeCallback(cb);
            }, 500);
        });

        const promises = [];

        promises.push(env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }));

        promises.push(env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "Another message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }));
        await Promise.all(promises);
        expect(connectCount).toBe(1);
    });

    // BOTS-41
    it("[BOTS-41] should be able to handle clashing nicks without causing echos",
    function(done) {
        let nickToClash = "M-kermit";
        let users = [
            {
                id: "@kermit:bar",
                assignedNick: "M-kermit"
            },
            {
                id: "@kermit:someplace",
                assignedNick: "M-kermit1"
            }
        ];

        let connectCount = 0;
        env.ircMock._whenClient(roomMapping.server, nickToClash, "connect",
        function(client, cb) {
            if (connectCount === 0) {
                client._invokeCallback(cb);
            }
            else {
                // add a number to their nick.
                client.nick = client.nick + connectCount;
                client._invokeCallback(cb);
            }
            connectCount += 1;
        });

        // not interested in joins
        users.forEach(function(user) {
            env.ircMock._autoJoinChannels(
                roomMapping.server, user.assignedNick, roomMapping.channel
            );
        });

        // catch attempts to send messages and fail coherently
        let sdk = env.clientMock._client(config._botUserId);
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + users[0].assignedNick,
            returnUserId: users[0].id
        });
        sdk.sendEvent.and.callFake(function(roomId, type, c) {
            expect(false).toBe(
                true, "bridge tried to send a msg to matrix from a virtual " +
                "irc user (clashing nicks)."
            );
            done();
            return Promise.resolve();
        });

        // send a message from the first guy
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: users[0].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            // send a message from the second guy
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "Another message",
                    msgtype: "m.text"
                },
                user_id: users[1].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).then(function() {
            // send a message from the first guy
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "3rd message",
                    msgtype: "m.text"
                },
                user_id: users[0].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).then(function() {
            // send an echo of the 3rd message: it shouldn't pass it through
            // because it is a virtual user!
            env.ircMock._findClientAsync(
                roomMapping.server, roomMapping.botNick
            ).then(function(client) {
                client.emit(
                    "message", users[0].assignedNick, roomMapping.channel,
                    "3rd message"
                );
                // TODO: We should really have a means to notify tests if the
                // bridge decides to do nothing due to it being an ignored user.
                setTimeout(function() {
                    done();
                }, 200);
            });
        });
    });

    it("should assign different ident usernames for long user IDs",
    function(done) {
        let usr1 = {
            nick: "M-averyverylongname",
            id: "@averyverylongname:localhost"
        };
        let usr2 = {
            nick: "M-averyverylongnameagain",
            id: "@averyverylongnameagain:localhost"
        };

        // not interested in join calls
        env.ircMock._autoJoinChannels(
            roomMapping.server, usr1.nick, roomMapping.channel
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, usr2.nick, roomMapping.channel
        );

        env.ircMock._whenClient(roomMapping.server, usr1.nick, "connect",
        function(client, cb) {
            usr1.username = client.opts.userName;
            client._invokeCallback(cb);
        });
        env.ircMock._whenClient(roomMapping.server, usr2.nick, "connect",
        function(client, cb) {
            usr2.username = client.opts.userName;
            client._invokeCallback(cb);
        });

        // mock a response for the state event.
        env.clientMock._client(config._botUserId).getStateEvent.and.callFake(function() {
            return Promise.resolve({});
        });

        // send a message to kick start the AS
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: usr1.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "A message2",
                    msgtype: "m.text"
                },
                user_id: usr2.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).then(function() {
            expect(usr1.username).toBeDefined();
            expect(usr2.username).toBeDefined();
            expect(usr1.username).not.toEqual(usr2.username);
            // should do something like "foo~1"
            expect(usr2.username[usr2.username.length - 1]).toEqual("1");
            done();
        });
    });

    it("should queue ident generation requests to avoid racing when querying for " +
            "cached ident usernames", function(done) {
        let usr1 = {
            nick: "M-averyverylongname",
            id: "@averyverylongname:localhost"
        };
        let usr2 = {
            nick: "M-averyverylongnameagain",
            id: "@averyverylongnameagain:localhost"
        };

        // not interested in join calls
        env.ircMock._autoJoinChannels(
            roomMapping.server, usr1.nick, roomMapping.channel
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, usr2.nick, roomMapping.channel
        );

        env.ircMock._whenClient(roomMapping.server, usr1.nick, "connect",
        function(client, cb) {
            usr1.username = client.opts.userName;
            client._invokeCallback(cb);
        });
        env.ircMock._whenClient(roomMapping.server, usr2.nick, "connect",
        function(client, cb) {
            usr2.username = client.opts.userName;
            client._invokeCallback(cb);
        });

        // mock a response for the state event.
        env.clientMock._client(config._botUserId).getStateEvent.and.callFake(function() {
            return Promise.resolve({});
        });

        // send a message to kick start the AS
        let p1 = env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: usr1.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        let p2 = env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message2",
                msgtype: "m.text"
            },
            user_id: usr2.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        Promise.all([p1, p2]).then(function() {
            expect(usr1.username).toBeDefined();
            expect(usr2.username).toBeDefined();
            expect(usr1.username).not.toEqual(usr2.username);
            done();
        });
    });

    it("should gracefully fail if it fails to join a channel when sending a message",
    async function() {
        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );

        let errorEmitted = false;
        env.ircMock._whenClient(roomMapping.server, testUser.nick, "join",
        (client) => {
            errorEmitted = true;
            client.emit("error", {
                command: "err_bannedfromchan",
                args: [roomMapping.channel]
            });
        });

        try {
            await env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "A message",
                    msgtype: "m.text"
                },
                user_id: testUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
            throw Error('Expected exception');
        }
        catch (ex) {
            expect(errorEmitted).toBe(true);
        }
    });

    it("should not bridge matrix users who are excluded", async function() {
        const excludedUserId = "@excluded:hs";
        const nick = "M-excluded";

        env.ircMock._whenClient(roomMapping.server, nick, "connect",
        function() {
            throw Error("Client should not be saying anything")
        });

        const botSdk = env.clientMock._client(config._botUserId);
        botSdk.kick.and.callFake(async (roomId, userId) => {
            if (roomId === roomMapping.roomId && userId === excludedUserId) {
                throw Error("Should not kick");
            }
        });

        try {
            await env.ircBridge.getClientPool().getBridgedClient(
                env.ircBridge.getServer(roomMapping.server),
                excludedUserId
            );
        }
        catch (ex) {
            expect(ex.message).toBe(
                "Cannot create bridged client - user is excluded from bridging"
            );
            return;
        }
        throw Error("Should have thrown");
    });

    it("should not bridge matrix users who are deactivated", async function() {
        const deactivatedUserId = "@deactivated:hs";
        const nick = "M-deactivated";

        const store = env.ircBridge.getStore();
        await store.deactivateUser(deactivatedUserId);
        expect(await store.isUserDeactivated(deactivatedUserId)).toBe(true);
        env.ircMock._whenClient(roomMapping.server, nick, "connect",
        function() {
            throw Error("Client should not be saying anything")
        });
        try {
            await env.ircBridge.getClientPool().getBridgedClient(
                env.ircBridge.getServer(roomMapping.server),
                deactivatedUserId
            );
        }
        catch (ex) {
            expect(ex.message).toBe(
                "Cannot create bridged client - user has been deactivated"
            );
            return;
        }
        throw Error("Should have thrown");
    });
});
