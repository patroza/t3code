# NTBS fixes

This document collects the units of work identified by the adversarial review of the NTBS design.

## 1. Recover accepted requests whose T3 thread was not recorded as started

The adapter records `RequestAccepted` before the processor creates the T3 thread. If the server stops after accepting the request but before recording `ThreadStarted`, the request remains unfinished. A repeated delivery cannot safely solve this by starting fresh because it is treated as a duplicate, and the previous attempt may already have created a T3 thread.

The request must retain a planned T3 thread ID before thread creation begins. Every creation attempt for that request must use the same thread ID, making a retry safe even if the previous attempt created the thread but failed before recording `ThreadStarted`.

The adapter must expose accepted requests that have no recorded `ThreadStarted`. When the processor starts, it must find those requests and retry thread creation using their stored thread IDs. A duplicate delivery must not create another thread; it may resume the existing unfinished request.
