const fengari = require('fengari');
const { to_luastring } = fengari;

let shouldStop = false;
const MAX_BUFFER_SIZE = 100;
const FLUSH_INTERVAL = 1000; // 1 second
let outputBuffer = [];
let lastFlushTime = Date.now();

function flushOutputBuffer() {
    if (outputBuffer.length > 0) {
        process.send({ type: 'output', data: outputBuffer.join('\n') });
        outputBuffer = [];
        lastFlushTime = Date.now();
    }
}

function handleStop() {
    shouldStop = true;
    flushOutputBuffer();
    process.send({ type: 'done' });
    process.exit(0);
}

process.on('message', (message) => {
    const { type, code } = message;
    
    if (type === 'stop') {
        handleStop();
        return;
    }
    
    if (type === 'execute') {
        let L = null;
        shouldStop = false;
        
        try {
            // Initialize Lua state
            L = fengari.lauxlib.luaL_newstate();
            if (!L) {
                throw new Error('Failed to create Lua state');
            }

            // Open standard libraries
            fengari.lualib.luaL_openlibs(L);

            // Override print function
            const luaPrint = function(L) {
                if (shouldStop) {
                    handleStop();
                    return 0;
                }
                
                const nargs = fengari.lua.lua_gettop(L);
                const args = [];
                for (let i = 1; i <= nargs; i++) {
                    if (fengari.lua.lua_isstring(L, i)) {
                        args.push(fengari.lua.lua_tojsstring(L, i));
                    } else if (fengari.lua.lua_isnumber(L, i)) {
                        args.push(fengari.lua.lua_tonumber(L, i));
                    } else if (fengari.lua.lua_isnil(L, i)) {
                        args.push('nil');
                    } else if (fengari.lua.lua_isboolean(L, i)) {
                        args.push(fengari.lua.lua_toboolean(L, i) ? 'true' : 'false');
                    } else {
                        args.push(fengari.lua.lua_typename(L, fengari.lua.lua_type(L, i)));
                    }
                }
                
                // Add to buffer
                outputBuffer.push(args.join(' '));
                
                // Check if we need to flush
                if (outputBuffer.length >= MAX_BUFFER_SIZE || 
                    Date.now() - lastFlushTime >= FLUSH_INTERVAL) {
                    flushOutputBuffer();
                }
                
                return 0;
            };

            fengari.lua.lua_pushjsfunction(L, luaPrint);
            fengari.lua.lua_setglobal(L, 'print');

            // Load the code
            const loadStatus = fengari.lauxlib.luaL_loadstring(L, fengari.to_luastring(code));
            if (loadStatus !== 0) {
                const error = fengari.lua.lua_tojsstring(L, -1);
                throw new Error('Lua Syntax Error: ' + error);
            }

            // Execute the code
            const runStatus = fengari.lua.lua_pcall(L, 0, 0, 0);
            if (runStatus !== 0) {
                const error = fengari.lua.lua_tojsstring(L, -1);
                throw new Error('Lua Runtime Error: ' + error);
            }

            flushOutputBuffer();
            process.send({ type: 'done' });

        } catch (error) {
            process.send({ type: 'error', error: error.message });
        } finally {
            if (L) {
                fengari.lua.lua_close(L);
                L = null;
            }
        }
    }
}); 