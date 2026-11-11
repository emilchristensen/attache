#!/usr/bin/env node
/** TEST-ONLY stand-in for Windows `whoami /user /fo csv /nh`, selected with JARVIS_WHOAMI_BIN. */
process.stdout.write('"desktop-test\\owner","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n');
