// Import Fengari from local file
importScripts('./fengari-web.js');

let L = null;
let isRunning = true;

self.onmessage = function(e) {
    const { type, code, breakpoints } = e.data;
    
    switch(type) {
        case 'execute':
            executeCode(code, breakpoints);
            break;
        case 'continue':
            self.postMessage({ type: 'resuming' });
            break;
        case 'stop':
            isRunning = false;
            if (L) {
                fengari.lua.lua_close(L);
                L = null;
            }
            break;
    }
};

function executeCode(code, breakpoints) {
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
            self.postMessage({ type: 'output', data: args.join(' ') });
            return 0;
        };

        fengari.lua.lua_pushjsfunction(L, luaPrint);
        fengari.lua.lua_setglobal(L, 'print');

        // Set up debug hook
        fengari.lua.lua_sethook(L, (L, ar) => {
            if (!ar || typeof ar.currentline !== 'number' || !isRunning) return;
            const currentLine = ar.currentline;
            
            if (breakpoints.includes(currentLine)) {
                self.postMessage({ type: 'breakpoint', line: currentLine });
                
                // Wait for continue message
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
        }, fengari.lua.LUA_MASKLINE, 0);

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

        self.postMessage({ type: 'done' });
    } catch (error) {
        self.postMessage({ type: 'error', error: error.message });
    } finally {
        if (L) {
            fengari.lua.lua_close(L);
            L = null;
        }
    }
} 