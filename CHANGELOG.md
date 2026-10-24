# [0.4.0](https://github.com/vx-daniel/pi-switchboard/compare/pi-switchboard-v0.3.0...pi-switchboard-v0.4.0) (2026-10-24)


### Bug Fixes

* a Codex usage limit answers 429 and cools for its reset time ([#185](https://github.com/vx-daniel/pi-switchboard/issues/185)) ([bc9a81e](https://github.com/vx-daniel/pi-switchboard/commit/bc9a81e2fbeccf6da583c2e32d5fb9909d3e1bbc))
* a cooling candidate is no alternative to a provider below its reserve ([cba07a0](https://github.com/vx-daniel/pi-switchboard/commit/cba07a07a81de1a6a01fa3570aca0574f6c8f9a6)), closes [#208](https://github.com/vx-daniel/pi-switchboard/issues/208)
* a shortened route in the Stats view keeps the served model ([9cec220](https://github.com/vx-daniel/pi-switchboard/commit/9cec220b1095eb1eb4d015c600d913ffb909eabb))
* address the [#189](https://github.com/vx-daniel/pi-switchboard/issues/189) review of quota tracking ([04532a8](https://github.com/vx-daniel/pi-switchboard/commit/04532a8473ed83824c9c76bf94c0ae91664aad84))
* address the second [#193](https://github.com/vx-daniel/pi-switchboard/issues/193) review ([ccc1bfa](https://github.com/vx-daniel/pi-switchboard/commit/ccc1bfa48383d406da50a031f6aa3a60486e9e61))
* compare the proxy token in constant time; match the Bearer scheme per RFC 7235 ([9c04e68](https://github.com/vx-daniel/pi-switchboard/commit/9c04e68b10d0bb8de505daa93eab7dce57ea39aa)), closes [#128](https://github.com/vx-daniel/pi-switchboard/issues/128)
* **config:** hold env vars and CLI flags to the config file's integer bounds ([5d0bd8d](https://github.com/vx-daniel/pi-switchboard/commit/5d0bd8d64f035949c9864f124bfd89d6956eb97f))
* **config:** refuse an alias target that mixes a model and a family ([#231](https://github.com/vx-daniel/pi-switchboard/issues/231)) ([83a3cb7](https://github.com/vx-daniel/pi-switchboard/commit/83a3cb7e3d1e90f6165c6e5c70eeba516c2642a8))
* **config:** refuse to start over a config file that cannot be read or parsed ([11877bb](https://github.com/vx-daniel/pi-switchboard/commit/11877bb27a4d0315c3245b1a0728cf43a68ceaa2))
* console failure paths, a pinned log view, and tui after flags ([8c0f6e2](https://github.com/vx-daniel/pi-switchboard/commit/8c0f6e2cae0b1ab474f0c69622984fa440b1872e))
* count a stream's failure once and notify listeners on clear ([#70](https://github.com/vx-daniel/pi-switchboard/issues/70)) ([5021465](https://github.com/vx-daniel/pi-switchboard/commit/50214657abac7c7b4065f3b41a14f1b40ffa3d63)), closes [#163](https://github.com/vx-daniel/pi-switchboard/issues/163) [#163](https://github.com/vx-daniel/pi-switchboard/issues/163)
* **deps:** upgrade pi to 1.4.0 ([#198](https://github.com/vx-daniel/pi-switchboard/issues/198)) ([d494566](https://github.com/vx-daniel/pi-switchboard/commit/d494566da644be616739f25d0d73b6bda4897866)), closes [#145](https://github.com/vx-daniel/pi-switchboard/issues/145)
* **errors:** answer a refused client key 401 and a missing login 502 ([5766b4d](https://github.com/vx-daniel/pi-switchboard/commit/5766b4d2b7ea5e9730585f8841311772749265a9)), closes [#128](https://github.com/vx-daniel/pi-switchboard/issues/128) [#128](https://github.com/vx-daniel/pi-switchboard/issues/128)
* fit long provider names in the Accounts view; pin the reserve's cooldown cases ([237bb98](https://github.com/vx-daniel/pi-switchboard/commit/237bb985919ec272afb0ae7a6a2f07371bb02f9a)), closes [#208](https://github.com/vx-daniel/pi-switchboard/issues/208)
* keep rejected requests apart, so a flood of them can't push out the rest ([9c20b5a](https://github.com/vx-daniel/pi-switchboard/commit/9c20b5a9eedf5b55f8903d21aa8b9be7f2f1b662))
* mark a stream inside its relay; offer the sidebar key only where it fits ([e3e1b8f](https://github.com/vx-daniel/pi-switchboard/commit/e3e1b8fc917b2f100324f6fb67f42ad2ac407cdb))
* match only pi's own capacity phrases, and test plural usage limits ([a441e34](https://github.com/vx-daniel/pi-switchboard/commit/a441e344087c86f2b20aa0e60045b6d26be823ad))
* name the console's sink format, keep a root-only category, test the layout ([bed21f2](https://github.com/vx-daniel/pi-switchboard/commit/bed21f27aa70fcbec1f5f6fc3ed413a059435c56)), closes [#204](https://github.com/vx-daniel/pi-switchboard/issues/204)
* **openai:** end each Responses stream item before the next starts ([#140](https://github.com/vx-daniel/pi-switchboard/issues/140)) ([e8e98cd](https://github.com/vx-daniel/pi-switchboard/commit/e8e98cdbfa73c0b2731e3a6087f588c42bc08c88))
* **openai:** refuse reasoning the proxy cannot replay; check turn alignment ([#140](https://github.com/vx-daniel/pi-switchboard/issues/140)) ([cfa6eae](https://github.com/vx-daniel/pi-switchboard/commit/cfa6eae8fe094a98fdaf1b5e3f193b86828434a6))
* **pi:** a failed availability refresh after registering logins does not stop startup ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([0cb3b37](https://github.com/vx-daniel/pi-switchboard/commit/0cb3b37c20bc37f7682cab860d7a1d70a52b9e56))
* **pi:** an extra login is configured by its own credential, never the base's env key ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([1c3607c](https://github.com/vx-daniel/pi-switchboard/commit/1c3607c3353b7ea95cf944d228784e3e5ffec6e7))
* say the flag still sets the token when auth is turned off over it ([d595800](https://github.com/vx-daniel/pi-switchboard/commit/d595800e12dc238e47f1c3cd9e9f8d18bd42a664))
* **server:** count streamed request bodies against the size limit ([#187](https://github.com/vx-daniel/pi-switchboard/issues/187)) ([63b815d](https://github.com/vx-daniel/pi-switchboard/commit/63b815d8cdb262ac9960ad973fc89dc375dff8ee))
* **server:** health checks in flight stay out of the requests table; long paths are cut ([4758bf1](https://github.com/vx-daniel/pi-switchboard/commit/4758bf17544f35da3dcd520d87ad0af5bf2e7f2d)), closes [#263](https://github.com/vx-daniel/pi-switchboard/issues/263)
* stats never stall requests, keep the real write error, bound rejected names ([52334c4](https://github.com/vx-daniel/pi-switchboard/commit/52334c494322851929e51b32dabfff93867e8664)), closes [#219](https://github.com/vx-daniel/pi-switchboard/issues/219)
* the console drops stale verifications and captures stderr by line ([6f8dab6](https://github.com/vx-daniel/pi-switchboard/commit/6f8dab6b568fefd07b3c754a1c56a963c442cb01)), closes [#195](https://github.com/vx-daniel/pi-switchboard/issues/195)
* the console fits a narrow terminal: wrapped log lines, shorter chrome ([876f266](https://github.com/vx-daniel/pi-switchboard/commit/876f26613dc169d361603a2f18adca3fe9ddc7ab)), closes [#203](https://github.com/vx-daniel/pi-switchboard/issues/203)
* the sidebar's RECENT title names rejected requests when nothing failed ([8bcf557](https://github.com/vx-daniel/pi-switchboard/commit/8bcf5578988ae91e385710a538eb83daa31a56b5))
* the Stats dashboard survives a failed read, and its docs follow the code ([1249ab9](https://github.com/vx-daniel/pi-switchboard/commit/1249ab9e9a25498327d5b72b289522cf72697037))
* the Stats view fits the terminal, keeps the cost visible, and is tested ([557e053](https://github.com/vx-daniel/pi-switchboard/commit/557e053bffa21167add6d965b68b3af23182cb6f))
* the Stats view keeps its total on a short screen and aligns wide labels ([cfc04d6](https://github.com/vx-daniel/pi-switchboard/commit/cfc04d6f46520ad2ad387cc480bd210eb5ef0753)), closes [#196](https://github.com/vx-daniel/pi-switchboard/issues/196)
* the Stats window keys act on the Stats view only ([9349b97](https://github.com/vx-daniel/pi-switchboard/commit/9349b97f5d469978e6d6cbe26d291b99cd0a97ae))
* the usage route reuses an answer for 5 s and survives a failed close ([7ee775d](https://github.com/vx-daniel/pi-switchboard/commit/7ee775db18992ecac0ff12bb810eb7468160e8f5))
* treat a Codex usage limit as a rate limit, and capacity wording as overload ([874df8d](https://github.com/vx-daniel/pi-switchboard/commit/874df8d5a6e72befe9744cff403424f5e6ada89f)), closes [#190](https://github.com/vx-daniel/pi-switchboard/issues/190)
* **tui:** keep a long cooldown countdown whole beside the matrix ([b0ae118](https://github.com/vx-daniel/pi-switchboard/commit/b0ae118dbb8ca0ac209687650d87618a7ea90b66)), closes [#262](https://github.com/vx-daniel/pi-switchboard/issues/262)
* **tui:** keep panel titles inside the frame; line up the accounts gauges ([59b8def](https://github.com/vx-daniel/pi-switchboard/commit/59b8deff1b90bb5610bc07a40d20bc0d7d14f09f))
* **tui:** logout drops the login's label; an unlistable store does not stop startup ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([c39e3ec](https://github.com/vx-daniel/pi-switchboard/commit/c39e3ec0949cd9acb83e1236a243390a398f418f))
* **tui:** refuse an alias name taken meanwhile; keep editing from what was saved ([#230](https://github.com/vx-daniel/pi-switchboard/issues/230)) ([31acaf4](https://github.com/vx-daniel/pi-switchboard/commit/31acaf4663f23e6c30d29aafd238a7a26e7f540b))
* **tui:** right-align the clock with colours on; one source for the model count ([175558f](https://github.com/vx-daniel/pi-switchboard/commit/175558ff33824c863d8a92badc68c34d8deb0abd))
* **tui:** save an alias named like a prototype key; report a failed write ([#230](https://github.com/vx-daniel/pi-switchboard/issues/230)) ([804eb21](https://github.com/vx-daniel/pi-switchboard/commit/804eb216520f4c751bd479712ef19faccd21c5ed))
* **tui:** say why a family's effort can't change; place pin options by name ([#231](https://github.com/vx-daniel/pi-switchboard/issues/231)) ([6de23a9](https://github.com/vx-daniel/pi-switchboard/commit/6de23a96064d8a4bf32263e6da1cd5c166b9a4dd))
* **tui:** the stats frame note follows the view; one usd formatter for every cost ([18067ca](https://github.com/vx-daniel/pi-switchboard/commit/18067cabe7eebbdf89a46ae3cb3a5f192d03da65)), closes [#261](https://github.com/vx-daniel/pi-switchboard/issues/261)


### Features

* build Windows binaries (x64, arm64) by hand, tested on native runners ([6d6a114](https://github.com/vx-daniel/pi-switchboard/commit/6d6a11474f490ee4c7f4ecc6a5343e1bfc126697))
* **config:** accounts, how many logins each provider has ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([2a14618](https://github.com/vx-daniel/pi-switchboard/commit/2a14618d1d6548c0231bc9909d5cd57accc02b33))
* **config:** routing.logins.fallbackOn, the failures that move between a model's logins ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([1c50a85](https://github.com/vx-daniel/pi-switchboard/commit/1c50a85400d7cf81b4d06cc52a17cc5345bc6aab))
* console sidebar lists recent requests and the last minute's rate; s toggles it ([6db95a4](https://github.com/vx-daniel/pi-switchboard/commit/6db95a49ad3a6469a119b5724f54a15fab985cae))
* console sidebar with the proxy, logins, requests in flight and traffic ([d752d38](https://github.com/vx-daniel/pi-switchboard/commit/d752d3899ab14021e97b94f04e336a351a8137b3))
* fallback chains keep a quota reserve per provider ([#69](https://github.com/vx-daniel/pi-switchboard/issues/69)) ([2cb35c2](https://github.com/vx-daniel/pi-switchboard/commit/2cb35c2d40ad48b828db4a2c463b3b750a58396e))
* keep per-minute traffic stats in SQLite, in a stats module ([#216](https://github.com/vx-daniel/pi-switchboard/issues/216)) ([ed61828](https://github.com/vx-daniel/pi-switchboard/commit/ed618285898ba049a66d30cfeeb3eb94ecd385af))
* navigate the console with the keyboard: select an account, Enter for its actions ([5e75e5f](https://github.com/vx-daniel/pi-switchboard/commit/5e75e5f2aa4848a4603bd634f449538479ec6a5e))
* **openai:** experimental, stateless Responses API at POST /v1/responses ([#140](https://github.com/vx-daniel/pi-switchboard/issues/140)) ([409c3da](https://github.com/vx-daniel/pi-switchboard/commit/409c3da118464e491040ce7e1129276c49391531))
* **openai:** report a clamped reasoning_effort as x_pi.reasoning_effort ([#175](https://github.com/vx-daniel/pi-switchboard/issues/175)) ([a75f26a](https://github.com/vx-daniel/pi-switchboard/commit/a75f26a89ebd0f33e83e9003dd2f86864336dfbd))
* per-route usage totals in memory ([#70](https://github.com/vx-daniel/pi-switchboard/issues/70)) ([140cf1d](https://github.com/vx-daniel/pi-switchboard/commit/140cf1dc9a803badfe54e8277e5c4056d025820e)), closes [#61](https://github.com/vx-daniel/pi-switchboard/issues/61)
* pi-switchboard tui, a console with live logs, accounts and logins through pi ([#61](https://github.com/vx-daniel/pi-switchboard/issues/61)) ([04ffd9d](https://github.com/vx-daniel/pi-switchboard/commit/04ffd9d66be4add35003883610c969821020d759))
* **pi:** find login slots in pi's store and add them from the console's login list ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([89acf12](https://github.com/vx-daniel/pi-switchboard/commit/89acf12ad836987e89fd208bbfa012849bc8359a))
* **pi:** name a login {provider}-N; pi-rotator's {provider}-account-N is read too ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([f1c6f4a](https://github.com/vx-daniel/pi-switchboard/commit/f1c6f4a67f1704b62b645159004f8864d78d7008))
* **pi:** register {provider}-account-N as providers of their own ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([f691def](https://github.com/vx-daniel/pi-switchboard/commit/f691def7e2eef5f0b08a8bc0cbbe09fccaf64785))
* proxy auth from the console, without a restart ([2a792ef](https://github.com/vx-daniel/pi-switchboard/commit/2a792ef57c93c60709b38eecb316adfaba3aea48))
* **routing:** an alias target sets the reasoning effort it runs at ([#230](https://github.com/vx-daniel/pi-switchboard/issues/230)) ([f7613bf](https://github.com/vx-daniel/pi-switchboard/commit/f7613bfba7f0aeb574d0c17b9fe485abccfdba4e))
* **routing:** end cooldowns early from the API or the console ([#182](https://github.com/vx-daniel/pi-switchboard/issues/182)) ([d8b49bb](https://github.com/vx-daniel/pi-switchboard/commit/d8b49bbb553cc70c55b2836a7fe0ac0b4c0c141c)), closes [#68](https://github.com/vx-daniel/pi-switchboard/issues/68) [#227](https://github.com/vx-daniel/pi-switchboard/issues/227)
* **routing:** family aliases that follow the newest exposed model ([#231](https://github.com/vx-daniel/pi-switchboard/issues/231)) ([d21fbb5](https://github.com/vx-daniel/pi-switchboard/commit/d21fbb564691ccf0ee2cdc1e81de33f51e0cc816))
* **routing:** one model per provider, routing picks the login ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([e0f3b72](https://github.com/vx-daniel/pi-switchboard/commit/e0f3b720611fba60377c9c9dba6e5e4e5b6f0c74))
* **server:** keep every HTTP request in memory for the console ([beba61b](https://github.com/vx-daniel/pi-switchboard/commit/beba61bdf85e4205b195aca511eedd861db08dee))
* the console counts chat requests the proxy turns away as rejected ([#214](https://github.com/vx-daniel/pi-switchboard/issues/214)) ([783fac6](https://github.com/vx-daniel/pi-switchboard/commit/783fac612b032b67934106effb26a89d350ce9b2))
* the console sidebar puts urgent panels first under stress ([#215](https://github.com/vx-daniel/pi-switchboard/issues/215)) ([e9f4344](https://github.com/vx-daniel/pi-switchboard/commit/e9f4344e76b367c7cc4a2b6134559e9ec8de74e7))
* the console's chrome on its own background, and the mouse wheel scrolls the log ([1891450](https://github.com/vx-daniel/pi-switchboard/commit/1891450550bb607c623a5a207dc63635efeb77aa))
* the console's Stats view as a dashboard over the stats file ([0740647](https://github.com/vx-daniel/pi-switchboard/commit/0740647a3de488ccaeaee9e35f9b0d39e0e8278b)), closes [#216](https://github.com/vx-daniel/pi-switchboard/issues/216) [#216](https://github.com/vx-daniel/pi-switchboard/issues/216)
* the console's Stats view, [#70](https://github.com/vx-daniel/pi-switchboard/issues/70)'s totals per alias and served model ([#61](https://github.com/vx-daniel/pi-switchboard/issues/61)) ([9f00183](https://github.com/vx-daniel/pi-switchboard/commit/9f001831e997c35011d6e7c2da9c60eaf9041d8b))
* the console's Tokyo Night Storm theme, for its views, its log and pi's dialogs ([fac24a1](https://github.com/vx-daniel/pi-switchboard/commit/fac24a17c6de97a2b408586957a5dd7fad4f0752))
* track subscription quota from response headers ([#69](https://github.com/vx-daniel/pi-switchboard/issues/69)) ([20ee8d6](https://github.com/vx-daniel/pi-switchboard/commit/20ee8d6e8ae662dd68d17e9b43449cc004fff6c5)), closes [#185](https://github.com/vx-daniel/pi-switchboard/issues/185)
* track the chat requests in flight, in memory, for the console ([7130ae9](https://github.com/vx-daniel/pi-switchboard/commit/7130ae9b794631a4600174d5a772f3f0de6d32ed))
* **tui:** a label per login, asked after a login and set from the account menu ([#227](https://github.com/vx-daniel/pi-switchboard/issues/227)) ([1ec89f7](https://github.com/vx-daniel/pi-switchboard/commit/1ec89f7b08f31a2eeb514990ee360705219616e3))
* **tui:** a Models view that lists models and edits aliases ([#230](https://github.com/vx-daniel/pi-switchboard/issues/230)) ([10de4b2](https://github.com/vx-daniel/pi-switchboard/commit/10de4b2f045bd66c1cc1f810e4dc33a482d60acb))
* **tui:** frame the view with folder tabs, and a keycap footer ([5b3c31b](https://github.com/vx-daniel/pi-switchboard/commit/5b3c31bdfd64e4a1bed71d6766458f27520b3354))
* **tui:** regroup the sidebar as QUOTA, IN FLIGHT, RECENT and SESSION ([163e78a](https://github.com/vx-daniel/pi-switchboard/commit/163e78a5b6e1148be2306fc25a118b85c2168c02))
* **tui:** screen layout model and the status strip ([efc2eb5](https://github.com/vx-daniel/pi-switchboard/commit/efc2eb5c5c27bb5d5650650c1cc5c9c797a0f150))
* **tui:** stats tiles that fold before the timeline, and today's cost on the strip ([ac780e0](https://github.com/vx-daniel/pi-switchboard/commit/ac780e070ce45757b7f8baac75127ce5fa042d5f))
* **tui:** the accounts view as a table with quota gauges and a detail pane ([8e67481](https://github.com/vx-daniel/pi-switchboard/commit/8e67481a8aa6fd5258294f53d88dec173c3df4f3))
* **tui:** the first view as a requests table, with r for the raw log ([ded7605](https://github.com/vx-daniel/pi-switchboard/commit/ded7605a5691314c39d2df94f93e90c90a9d85b0))
* **tui:** the models view as an effort matrix with an aliases box ([84b6826](https://github.com/vx-daniel/pi-switchboard/commit/84b68267293ef13ec8126472481a011d21c4652d))
* usage over HTTP from the stats file, and per-alias usage in the console ([871b5c5](https://github.com/vx-daniel/pi-switchboard/commit/871b5c50dea8286560499405ca4413d94fee0abb)), closes [#224](https://github.com/vx-daniel/pi-switchboard/issues/224)

# [0.3.0](https://github.com/vx-daniel/pi-switchboard/compare/pi-switchboard-v0.2.0...pi-switchboard-v0.3.0) (2026-10-21)


### Bug Fixes

* a success clears only cooldowns that started before it was sent ([5aa1567](https://github.com/vx-daniel/pi-switchboard/commit/5aa1567d133c1894d7fc2d59bc5fad70b85e7743)), closes [#181](https://github.com/vx-daniel/pi-switchboard/issues/181)
* address the [#181](https://github.com/vx-daniel/pi-switchboard/issues/181) review of cooldowns ([fd63a56](https://github.com/vx-daniel/pi-switchboard/commit/fd63a568b39a10a209780768282540b8367dca40))
* keep a cooldown's end within what a Date can hold ([1441ff9](https://github.com/vx-daniel/pi-switchboard/commit/1441ff9fcd8012abda19f5e19210985671b35138)), closes [#181](https://github.com/vx-daniel/pi-switchboard/issues/181)
* keep own-key requests out of shared cooldowns; skip non-full buckets ([7cc7030](https://github.com/vx-daniel/pi-switchboard/commit/7cc7030a92992f973fc83ba8bbc723cf97424c30)), closes [#181](https://github.com/vx-daniel/pi-switchboard/issues/181)
* read reset times in epoch milliseconds, and only real dates ([60b7576](https://github.com/vx-daniel/pi-switchboard/commit/60b7576ef377a6386875b976d0d218cd7e848cbd)), closes [#181](https://github.com/vx-daniel/pi-switchboard/issues/181)
* read retry-after-ms strictly, and apart from retry-after ([5f69d4b](https://github.com/vx-daniel/pi-switchboard/commit/5f69d4b8ced057932bc7f075a8185b5451aed67c)), closes [#181](https://github.com/vx-daniel/pi-switchboard/issues/181)


### Features

* catalogue data on /v1/switchboard/models ([#173](https://github.com/vx-daniel/pi-switchboard/issues/173)) ([abf4705](https://github.com/vx-daniel/pi-switchboard/commit/abf4705c8599999c2208991a2a1f0b544676c554))
* cooldowns after rate limits ([#68](https://github.com/vx-daniel/pi-switchboard/issues/68)) ([e291d34](https://github.com/vx-daniel/pi-switchboard/commit/e291d344d81e564f808343ffceb63f3d70473546))
* fallback chains for aliases ([#67](https://github.com/vx-daniel/pi-switchboard/issues/67)) ([7b74213](https://github.com/vx-daniel/pi-switchboard/commit/7b7421315e4186d429ef198e07d2eecfc035d4d9))
* model aliases, names for exposed models ([#66](https://github.com/vx-daniel/pi-switchboard/issues/66)) ([35d89d1](https://github.com/vx-daniel/pi-switchboard/commit/35d89d16007b40df02191ea95871614434e9ebc2))

# [0.2.0](https://github.com/vx-daniel/pi-switchboard/compare/pi-switchboard-v0.1.0...pi-switchboard-v0.2.0) (2026-10-21)


### Bug Fixes

* drop unintended fallow config; smoke the built CLI in the gate (review on [#167](https://github.com/vx-daniel/pi-switchboard/issues/167)) ([5b645c6](https://github.com/vx-daniel/pi-switchboard/commit/5b645c649e76924202ea1a88786b83674f41852d))
* name a missing pi package at CLI start; match pi on Windows (review on [#167](https://github.com/vx-daniel/pi-switchboard/issues/167)) ([38da439](https://github.com/vx-daniel/pi-switchboard/commit/38da43993d21d5fcc66122fd5e691df84ef78840))
* print the package version for --version ([#168](https://github.com/vx-daniel/pi-switchboard/issues/168)) ([1c11196](https://github.com/vx-daniel/pi-switchboard/commit/1c111960b215a6c817d111a584ee8ab831e1dfb5))
* retry every breakpoint refusal, not only the first (review on [#166](https://github.com/vx-daniel/pi-switchboard/issues/166)) ([fc31356](https://github.com/vx-daniel/pi-switchboard/commit/fc31356a04ce974682a8ed62d8efcb86094e87b4))
* retry once without prompt_cache_breakpoint when a model refuses it, and remember it ([af5e757](https://github.com/vx-daniel/pi-switchboard/commit/af5e757cb9a78d91bc6c845a0cf76dea60f7e12e)), closes [#163](https://github.com/vx-daniel/pi-switchboard/issues/163) [#163](https://github.com/vx-daniel/pi-switchboard/issues/163)
* stop loading a second copy of pi inside pi's process ([28320f7](https://github.com/vx-daniel/pi-switchboard/commit/28320f77eb3556e27f37b3ae3a730b064c5810e1)), closes [#165](https://github.com/vx-daniel/pi-switchboard/issues/165) [#165](https://github.com/vx-daniel/pi-switchboard/issues/165)


### Features

* publish the pi package to GitHub Packages from each release tag ([049204a](https://github.com/vx-daniel/pi-switchboard/commit/049204abf156fcc8f34d083ace022341ba65187d)), closes [#59](https://github.com/vx-daniel/pi-switchboard/issues/59) [#59](https://github.com/vx-daniel/pi-switchboard/issues/59)

# [0.1.0](https://github.com/vx-daniel/pi-switchboard/compare/pi-switchboard-v0.0.0...pi-switchboard-v0.1.0) (2026-10-21)


* feat!: rename the env vars to PI_SWITCHBOARD_* and the upstream key header ([6b6e0c5](https://github.com/vx-daniel/pi-switchboard/commit/6b6e0c5cca0fdda49c8100be96e49253c5739c1f)), closes [#65](https://github.com/vx-daniel/pi-switchboard/issues/65)
* feat!: rename the project to pi-switchboard ([33abb76](https://github.com/vx-daniel/pi-switchboard/commit/33abb7638c6ac1e1e309e289d727b5b4e020a7e8))
* feat(server)!: move /v1/pi/models to /v1/switchboard/models ([e2b1ce3](https://github.com/vx-daniel/pi-switchboard/commit/e2b1ce3ef2e7380d283e2c8d8f6629435a599fd5))


### Bug Fixes

* accept a repeated ?verify= and document the trimmed model path (review on [#142](https://github.com/vx-daniel/pi-switchboard/issues/142)) ([ad55361](https://github.com/vx-daniel/pi-switchboard/commit/ad55361fa9925f7f6bc6c3e85bea0b4040454dcb))
* accept an SDK-echoed assistant reply as sent (review on [#155](https://github.com/vx-daniel/pi-switchboard/issues/155)) ([acc549c](https://github.com/vx-daniel/pi-switchboard/commit/acc549cb93c8f7b9635bdbee26f588abcc465b1b))
* answer a model the provider login cannot use with 404 model_not_found ([a300a36](https://github.com/vx-daniel/pi-switchboard/commit/a300a368da66eb790a98699a36126326ff5d84c4)), closes [#156](https://github.com/vx-daniel/pi-switchboard/issues/156)
* answer provider refusals of a client's field as 400, log pi's Claude temperature drop ([#147](https://github.com/vx-daniel/pi-switchboard/issues/147)) ([fb8a322](https://github.com/vx-daniel/pi-switchboard/commit/fb8a3226ffa8c9b19edfea345a9f2d490ea9d50d)), closes [#128](https://github.com/vx-daniel/pi-switchboard/issues/128)
* **auth:** fail closed when authToken in proxy-config.json is not a string ([9f77029](https://github.com/vx-daniel/pi-switchboard/commit/9f77029e3885a3f6198fa706ee26029e211c0d3a))
* **auth:** fail closed with a clear error on an empty --auth-token or PI_PROXY_AUTH_TOKEN ([b9c7514](https://github.com/vx-daniel/pi-switchboard/commit/b9c7514633b08c8749f1a2846fbb95372fa6705e))
* **auth:** keep pi's raw credential error out of the chat 401 and warn logs ([e01880b](https://github.com/vx-daniel/pi-switchboard/commit/e01880b705c9dafe6e5d4e5a26aaa6f1ff1f6054)), closes [#18](https://github.com/vx-daniel/pi-switchboard/issues/18)
* **auth:** log the model with a failed chat credential lookup; drop the stray audit file ([95f0ce9](https://github.com/vx-daniel/pi-switchboard/commit/95f0ce9ad5ae22dde91d467a218af36c9c445fad))
* **auth:** read the config file once per auth row; test reset and --auth-token ([108b204](https://github.com/vx-daniel/pi-switchboard/commit/108b20464acfc0cd820a40e66c4de6e7a0bbbb2b))
* **auth:** refuse to start when proxy auth is set but cannot be applied ([8b9dd8a](https://github.com/vx-daniel/pi-switchboard/commit/8b9dd8ab330f958fadde2ac13c9afd356cc9626c)), closes [#99](https://github.com/vx-daniel/pi-switchboard/issues/99) [#82](https://github.com/vx-daniel/pi-switchboard/issues/82)
* check Codex's model refusal before credential wording, pin its error log (review on [#157](https://github.com/vx-daniel/pi-switchboard/issues/157)) ([2d215b0](https://github.com/vx-daniel/pi-switchboard/commit/2d215b0c2f7e18ae777d9a60ac07fb5505509ff4))
* **cli:** keep the issue number out of --help; say --config is not the effective config ([d871210](https://github.com/vx-daniel/pi-switchboard/commit/d871210f98a42de13a32e7db0ce262535b5eae5d))
* **cli:** make the --help text match what the flags do ([44136e5](https://github.com/vx-daniel/pi-switchboard/commit/44136e5826a8ee42a47abbf954659dea03c6e05c)), closes [#109](https://github.com/vx-daniel/pi-switchboard/issues/109)
* **codex:** drop temperature visibly; correct the tool_choice comments ([52154ca](https://github.com/vx-daniel/pi-switchboard/commit/52154ca852836559d1be4627275b866491329bcd)), closes [#49](https://github.com/vx-daniel/pi-switchboard/issues/49)
* **codex:** log the first temperature drop per model at info, the rest at debug ([fca4be4](https://github.com/vx-daniel/pi-switchboard/commit/fca4be434bb082ce73a278318e16c9456655b1e1)), closes [#64](https://github.com/vx-daniel/pi-switchboard/issues/64)
* **config:** derive the config types from Zod; repair bad fields with a warning ([e12d304](https://github.com/vx-daniel/pi-switchboard/commit/e12d304a9246fc00d6300438a167dd9aa45ccdc4))
* **errors:** answer context overflows as 400 context_length_exceeded ([361faad](https://github.com/vx-daniel/pi-switchboard/commit/361faad1304a0082869b0c83df22671cee4ec541)), closes [#40](https://github.com/vx-daniel/pi-switchboard/issues/40)
* **errors:** map upstream failures by reported status; map streamed errors too ([e422fdb](https://github.com/vx-daniel/pi-switchboard/commit/e422fdb4f18f2f30b0d2bcfcb6f258d402e93ad4)), closes [#42](https://github.com/vx-daniel/pi-switchboard/issues/42) [#54](https://github.com/vx-daniel/pi-switchboard/issues/54)
* **errors:** read a leading status only where pi puts one; map stream errors once ([9929f82](https://github.com/vx-daniel/pi-switchboard/commit/9929f827a503ee5704002708bc83066ed4dccc7d)), closes [#56](https://github.com/vx-daniel/pi-switchboard/issues/56)
* **exposure:** expose no model in custom mode with an empty list ([74fefd3](https://github.com/vx-daniel/pi-switchboard/commit/74fefd3ad1aa8d2dec21b60dea852d1438867c2f))
* **exposure:** resolve enabledModels patterns as pi does ([edcbe62](https://github.com/vx-daniel/pi-switchboard/commit/edcbe6292e598518f7cb2171fc2a72c03184f463)), closes [#46](https://github.com/vx-daniel/pi-switchboard/issues/46)
* **extension:** find pi's agent dir as pi does; say what stop and auto-sync really did ([093e108](https://github.com/vx-daniel/pi-switchboard/commit/093e108d228405905148c41c9be055175909abde))
* **extension:** jump to the previous provider's first model on Left ([69e5375](https://github.com/vx-daniel/pi-switchboard/commit/69e53751852c4478ec9ff6570d67159fcc582361))
* **extension:** keep another user's proxy in /proxy stop; say so on start ([f450fcb](https://github.com/vx-daniel/pi-switchboard/commit/f450fcb644bf9a4de81c60a786d9a4747e63eef9)), closes [#93](https://github.com/vx-daniel/pi-switchboard/issues/93) [#97](https://github.com/vx-daniel/pi-switchboard/issues/97)
* **extension:** keep the PID file of another user's live proxy ([5ca8b5a](https://github.com/vx-daniel/pi-switchboard/commit/5ca8b5a9ed9caa1ee3073a7840f791b121375070))
* **extension:** say [dry-run] once in /proxy zed-sync --dry-run ([9b1a5aa](https://github.com/vx-daniel/pi-switchboard/commit/9b1a5aa73c209a8e26c1fa668ca1ccd5b44bb94a))
* **extension:** show the proxy token as a preview in /proxy show; add /proxy token ([0cd3ff0](https://github.com/vx-daniel/pi-switchboard/commit/0cd3ff0a5d22dbba3f024fce221b459b67959450))
* **google:** set passthrough sampling fields flat on config, where @google/genai reads them ([e045a87](https://github.com/vx-daniel/pi-switchboard/commit/e045a870d07170464d8449ecffbaee02b0f84792))
* **health:** keep the token endpoint's response out of verify errors ([1d1610b](https://github.com/vx-daniel/pi-switchboard/commit/1d1610bf3d8bb1ec50c8c945f798662e5e551fc6))
* **health:** stricter verify error summary, 503 for a check that throws ([7e03c46](https://github.com/vx-daniel/pi-switchboard/commit/7e03c46360454ed334fb02bf6cc6ad761008159b))
* **images:** cap a request's remote images at 15 MiB in all; fetch only after the credential check ([a299394](https://github.com/vx-daniel/pi-switchboard/commit/a299394c49b7cd62e47fd97382edce912994f8c3))
* **images:** log the resolver's error code when an image host does not resolve ([721f4ad](https://github.com/vx-daniel/pi-switchboard/commit/721f4adc8012f0dfe0e2fd72e1b090ba0e652522))
* keep a provider's credential 400 an auth failure (review on [#154](https://github.com/vx-daniel/pi-switchboard/issues/154)) ([75e2500](https://github.com/vx-daniel/pi-switchboard/commit/75e250092e7b07df947f9b5e5b087c35a34de81d))
* keep whitespace in request text instead of trimming it ([#145](https://github.com/vx-daniel/pi-switchboard/issues/145)) ([cdf7bae](https://github.com/vx-daniel/pi-switchboard/commit/cdf7bae2259203b5a1d8f9a76e909b094612e458))
* leave blank parts out of system and developer text ([#149](https://github.com/vx-daniel/pi-switchboard/issues/149) review) ([65efff5](https://github.com/vx-daniel/pi-switchboard/commit/65efff5d39e7673aef15e4076068a7d6f6baf6e4)), closes [#145](https://github.com/vx-daniel/pi-switchboard/issues/145)
* **logging:** act on the PR [#11](https://github.com/vx-daniel/pi-switchboard/issues/11) review ([fb9cf22](https://github.com/vx-daniel/pi-switchboard/commit/fb9cf226b6f4407eff6c738a9d4a8a86fb578346))
* **logging:** keep raw upstream error text at debug everywhere ([3c3ac91](https://github.com/vx-daniel/pi-switchboard/commit/3c3ac919b8304a3e3fce287da0eb5881aff1af39)), closes [#11](https://github.com/vx-daniel/pi-switchboard/issues/11)
* **messages:** keep later system and developer messages in place ([7a3a782](https://github.com/vx-daniel/pi-switchboard/commit/7a3a782f0807e85977ce2a85759ca6fa7fcea631)), closes [#45](https://github.com/vx-daniel/pi-switchboard/issues/45)
* **openai:** accept text-part content in system and developer messages ([e905b13](https://github.com/vx-daniel/pi-switchboard/commit/e905b137c9941cd930a22d5cf73bc3e241b7f87c))
* **openai:** refuse a malformed required, put the role on the first chunk, word errors exactly ([7ca8eef](https://github.com/vx-daniel/pi-switchboard/commit/7ca8eefadafbf0873cb3c305914f5feab3a8a3ad))
* **reasoning:** cheaper clamp detection; test /v1/pi/models auth and exposure ([c7fc610](https://github.com/vx-daniel/pi-switchboard/commit/c7fc61078fc309b78a7b6eaa040df8a3eb0a3934)), closes [#71](https://github.com/vx-daniel/pi-switchboard/issues/71)
* **reasoning:** reasoning_effort none turns reasoning off ([3e79f9f](https://github.com/vx-daniel/pi-switchboard/commit/3e79f9f0b13a53e1daab8e1a5710dc79ba534880)), closes [#41](https://github.com/vx-daniel/pi-switchboard/issues/41)
* **registry:** keep models.json content out of /healthz/models and the startup log ([c8ccab4](https://github.com/vx-daniel/pi-switchboard/commit/c8ccab4a43299e76908a457738e572fd089a83dc)), closes [#19](https://github.com/vx-daniel/pi-switchboard/issues/19)
* **registry:** split pi's models.json error at the last file separator ([efe5016](https://github.com/vx-daniel/pi-switchboard/commit/efe5016e3982ffc736ecf77497073679000773ca))
* **responses:** send choices[].logprobs as null, drop system_fingerprint ([2b544be](https://github.com/vx-daniel/pi-switchboard/commit/2b544be1dc4513903aa7e7d0fbebf39a5626efcb)), closes [#132](https://github.com/vx-daniel/pi-switchboard/issues/132)
* **runtime:** drop the dead Codex and gemini-cli paths; look up Zed settings as Zed does ([f49223c](https://github.com/vx-daniel/pi-switchboard/commit/f49223c3746ee35d719c18590d5baf84f5cce33c))
* **server:** answer unmatched routes with an OpenAI-style 404 ([aeb7fa6](https://github.com/vx-daniel/pi-switchboard/commit/aeb7fa69c26d233d782f3b3415b0293d65779f3f))
* **server:** check the old upstream key header only on chat, after auth ([2f722df](https://github.com/vx-daniel/pi-switchboard/commit/2f722df4b414a68f83c8fc239e2eb94139541647))
* settle the three [#95](https://github.com/vx-daniel/pi-switchboard/issues/95) oddities ([b8b6f9f](https://github.com/vx-daniel/pi-switchboard/commit/b8b6f9feff84ecf2bbf88f124ed4998f7813a130))
* **stream:** close the upstream iterator early; client exit on a throw ([d081d17](https://github.com/vx-daniel/pi-switchboard/commit/d081d17562b3d01467faf2c251be7ce9539a7b26)), closes [#58](https://github.com/vx-daniel/pi-switchboard/issues/58)
* strict message and part schemas, name and image detail listed drops ([#146](https://github.com/vx-daniel/pi-switchboard/issues/146)) ([03ae749](https://github.com/vx-daniel/pi-switchboard/commit/03ae7495418f4d65c04825a67e077a3de6ccf1f0))
* **test:** load the fixture recorder under plain Node again ([69ca479](https://github.com/vx-daniel/pi-switchboard/commit/69ca4793e2d0d9af7ad23db712d8441c08c567a1)), closes [#101](https://github.com/vx-daniel/pi-switchboard/issues/101)
* **timeout:** restart the idle wait on raw provider events ([63ab7e0](https://github.com/vx-daniel/pi-switchboard/commit/63ab7e08e3e294cabbaca27e9f85fd846cb6cb0b))
* **tools:** apply strict through pi's constrained sampling on every API ([100d7f4](https://github.com/vx-daniel/pi-switchboard/commit/100d7f46256e2e25a56105424dddf5c328cf89a0)), closes [#44](https://github.com/vx-daniel/pi-switchboard/issues/44)
* **tools:** carry a sibling type on anyOf and string enum constraints ([a573c50](https://github.com/vx-daniel/pi-switchboard/commit/a573c5081a99d87cea6f7cbf234988711e37a9e7)), closes [#52](https://github.com/vx-daniel/pi-switchboard/issues/52)
* **tools:** keep tool schema constraints; reject keywords outside the subset ([461a00d](https://github.com/vx-daniel/pi-switchboard/commit/461a00d217ea5f46b7a5aaec15f5dcefb7ea01ef)), closes [#37](https://github.com/vx-daniel/pi-switchboard/issues/37)
* **upstream:** end the relayed stream with an error if reading pi's stream throws ([01dc51a](https://github.com/vx-daniel/pi-switchboard/commit/01dc51a1ff0ec66d5b269b2753679dded405f190))
* **upstream:** keep a client disconnect out of the timeout label, unref the timer ([12b6b74](https://github.com/vx-daniel/pi-switchboard/commit/12b6b74c2f6c3d2edbfdaf673aaf56e399a0c70c))
* **upstream:** time out on silence, not on the length of the call ([49b68d1](https://github.com/vx-daniel/pi-switchboard/commit/49b68d1e97f3df22910a37c815239eb2d622dcff))
* warn when no breakpoint could be placed on an OpenAI payload (review on [#151](https://github.com/vx-daniel/pi-switchboard/issues/151)) ([6ceac71](https://github.com/vx-daniel/pi-switchboard/commit/6ceac718fe4fd6b969f4ae371c8cb5a1b944f06d))
* **zed:** leave settings that are not valid JSONC untouched ([406a8b9](https://github.com/vx-daniel/pi-switchboard/commit/406a8b9d7e6af33281913ac5683245f0d29a2c8f)), closes [#25](https://github.com/vx-daniel/pi-switchboard/issues/25)
* **zed:** sync into empty settings again; report line and column ([ae88645](https://github.com/vx-daniel/pi-switchboard/commit/ae886457784d020271d113aa133fcfe6343b1b3d))


### Features

* accept prompt_cache_key and pass it to pi as sessionId ([#39](https://github.com/vx-daniel/pi-switchboard/issues/39)) ([1aebc57](https://github.com/vx-daniel/pi-switchboard/commit/1aebc575f4d277111aefaf5475f37dfb246dfacb)), closes [#129](https://github.com/vx-daniel/pi-switchboard/issues/129)
* build the container image from this repo and publish it to GHCR on release ([7bb36d1](https://github.com/vx-daniel/pi-switchboard/commit/7bb36d1a9b1bf39d25dda66bf89a67a4c69fc4f2)), closes [#60](https://github.com/vx-daniel/pi-switchboard/issues/60) [#60](https://github.com/vx-daniel/pi-switchboard/issues/60)
* **chat:** accept reasoning_effort "max" as pi's max thinking level ([07f2ea2](https://github.com/vx-daniel/pi-switchboard/commit/07f2ea208f11b52d575ef7777321f61397b5990b)), closes [#132](https://github.com/vx-daniel/pi-switchboard/issues/132)
* forward prompt_cache_breakpoint to OpenAI, drop it elsewhere (constitution 3.1.0) ([327c37b](https://github.com/vx-daniel/pi-switchboard/commit/327c37bfe2bb247c62b02004562601f2c4b4317f)), closes [#149](https://github.com/vx-daniel/pi-switchboard/issues/149)
* **images:** fetch remote image URLs behind remoteImages, SSRF-safe ([5c09d5c](https://github.com/vx-daniel/pi-switchboard/commit/5c09d5cd030bcb45f29d330a476cfa4184ddeb07))
* **lint:** port the naming.grit Biome plugin to an Oxlint/ESLint plugin ([d2a895d](https://github.com/vx-daniel/pi-switchboard/commit/d2a895df1e924e564896ddb305f936a0eedddf27))
* **logging:** local-time pretty output, a format override, quiet model polling ([2a79bfc](https://github.com/vx-daniel/pi-switchboard/commit/2a79bfc66aaaf8f3624336c04a339385e8824e76))
* **logging:** log decisions across the proxy and the extension ([0a8f36f](https://github.com/vx-daniel/pi-switchboard/commit/0a8f36f64888172b689d559cdeaea37195b5ea27))
* **logging:** move from console logging to LogTape ([911e307](https://github.com/vx-daniel/pi-switchboard/commit/911e307bce3e3e4646c9395cb44b50893e6db081))
* publish the image to Docker Hub as well as GHCR, docs lead with Docker Hub ([b2889fa](https://github.com/vx-daniel/pi-switchboard/commit/b2889fadc31fe7da78dd87d59a2b97e321c8c8a9))
* **reasoning:** clamp unsupported reasoning_effort; list supported efforts on /v1/pi/models ([17aafbe](https://github.com/vx-daniel/pi-switchboard/commit/17aafbee74c9b70252cd5cc20745973d6e8f5a7e))
* **server:** /healthz liveness plus /healthz/models and /healthz/creds detail checks ([ec864bf](https://github.com/vx-daniel/pi-switchboard/commit/ec864bf39cad6a472670b5b36a1d512e6293b0a3))
* **server:** docs page at /docs; the OpenAPI document covers every route ([a9fbdbc](https://github.com/vx-daniel/pi-switchboard/commit/a9fbdbc29637abc40b05d7a9ed3e5a8c7261e21b))
* **server:** publish the API as an OpenAPI document, with opt-in Swagger UI ([08287e0](https://github.com/vx-daniel/pi-switchboard/commit/08287e00e7b6ea8885b1a5dbe6df732895a57f5a))
* validate request parameters and bodies with hono-openapi's validator() ([0e0bde1](https://github.com/vx-daniel/pi-switchboard/commit/0e0bde187855de9ee93b2659b275863c5e094693))


### BREAKING CHANGES

* set PI_SWITCHBOARD_* instead of PI_PROXY_*, and send
X-Switchboard-Upstream-Api-Key instead of X-Pi-Upstream-Api-Key.
* the package is @vx-daniel/pi-switchboard and the bin is
pi-switchboard; log categories start with pi-switchboard instead of
pi-openai-proxy.

Closes #65.
* GET /v1/pi/models is gone; call
GET /v1/switchboard/models instead.
* **logging:** log lines use LogTape's JSON Lines shape (@timestamp,
level, logger, message, properties) instead of {ts, level, event, ...},
and --config prints to stdout.

## [4.9.6](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.5...v4.9.6) (2026-06-08)


### Bug Fixes

* migrate pi deps to [@earendil-works](https://github.com/earendil-works) namespace ([75dcc86](https://github.com/victor-software-house/pi-openai-proxy/commit/75dcc869d6661c0a14d6c975942f50cab9453ad8))
* patch publish private GH packages ([d956bb2](https://github.com/victor-software-house/pi-openai-proxy/commit/d956bb2b1e2030c238b5628ecc1257e5d52c56db))

## [4.9.6](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.5...v4.9.6) (2026-05-12)


### Bug Fixes

* migrate Pi SDK imports to `@earendil-works` packages and align package baseline

## [4.9.5](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.4...v4.9.5) (2026-05-06)


### Bug Fixes

* resolve bun runtime for proxy startup ([c6c2cb9](https://github.com/victor-software-house/pi-openai-proxy/commit/c6c2cb9e9b32dc842eff79ccadf313be5e5d5687))

## [4.9.4](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.3...v4.9.4) (2026-05-06)


### Bug Fixes

* update proxy for pi 0.73 ([6b9a080](https://github.com/victor-software-house/pi-openai-proxy/commit/6b9a080ac1756052f3b51ac49956388cf18e5c20))

## [4.9.3](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.2...v4.9.3) (2026-03-29)


### Bug Fixes

* migrate upstream auth to getApiKeyAndHeaders ([4c23a97](https://github.com/victor-software-house/pi-openai-proxy/commit/4c23a970c6c94fdc1a3e47a3995770ce00602f50))

## [4.9.2](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.1...v4.9.2) (2026-03-26)


### Bug Fixes

* resolve tool name for tool result messages from assistant tool_calls ([7ab6e14](https://github.com/victor-software-house/pi-openai-proxy/commit/7ab6e143300b47415cc2ef85d25c7cf428cb8e95))

## [4.9.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.9.0...v4.9.1) (2026-03-26)


### Bug Fixes

* default empty instructions for codex-responses when no system message ([b902ec2](https://github.com/victor-software-house/pi-openai-proxy/commit/b902ec2d3be8b9a3f8ee7018107d8eefb6ba67c5))

# [4.9.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.8.0...v4.9.0) (2026-03-26)


### Features

* add codex-responses restricted passthrough for tool_choice ([549bc37](https://github.com/victor-software-house/pi-openai-proxy/commit/549bc376bbdc6471e024ef5b6f2bce8eec6e3da0))

# [4.8.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.7.1...v4.8.0) (2026-03-26)


### Features

* add API-aware payload translation for Anthropic and Google ([b65a00a](https://github.com/victor-software-house/pi-openai-proxy/commit/b65a00a9d33110ccbe3d2de562055afc04af1c21))

## [4.7.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.7.0...v4.7.1) (2026-03-26)


### Bug Fixes

* restrict onPayload passthrough to OpenAI-compatible APIs only ([e99a20a](https://github.com/victor-software-house/pi-openai-proxy/commit/e99a20ae4bbb48f924152f5f5264e87fb089d240))

# [4.7.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.6.1...v4.7.0) (2026-03-26)


### Features

* promote parallel_tool_calls, metadata, prediction to passthrough ([322734c](https://github.com/victor-software-house/pi-openai-proxy/commit/322734c7390ed0063085b2a480fd42e16b38c506))

## [4.6.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.6.0...v4.6.1) (2026-03-26)


### Bug Fixes

* forward tool_choice and strict flags via onPayload passthrough ([2fe2da3](https://github.com/victor-software-house/pi-openai-proxy/commit/2fe2da3dcc3f14d3799410a35cd8e123d0e43b08))

# [4.6.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.5.1...v4.6.0) (2026-03-25)


### Features

* **zed-sync:** run auto-sync on session start ([503007a](https://github.com/victor-software-house/pi-openai-proxy/commit/503007a20d3b4121be5b86bf47d758e3cf0410b9))

## [4.5.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.5.0...v4.5.1) (2026-03-25)


### Bug Fixes

* cover extensions/ in typecheck and lint, fix all type safety violations ([54e90e2](https://github.com/victor-software-house/pi-openai-proxy/commit/54e90e2af2f69ba0c1fa221cd04f646f62060360))

# [4.5.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.4.1...v4.5.0) (2026-03-25)


### Features

* **zed-sync:** add zed config section with auto-sync ([8b9a779](https://github.com/victor-software-house/pi-openai-proxy/commit/8b9a7792e927fda1fb5671dedc37642648698f62))

## [4.4.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.4.0...v4.4.1) (2026-03-25)


### Bug Fixes

* **lint:** disable useLiteralKeys, incompatible with noPropertyAccessFromIndexSignature ([375ebef](https://github.com/victor-software-house/pi-openai-proxy/commit/375ebefb6af037cfa6b5f643b6dc19b626487a38))

# [4.4.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.3.1...v4.4.0) (2026-03-25)


### Features

* **zed-sync:** add /proxy zed-sync command ([af60c12](https://github.com/victor-software-house/pi-openai-proxy/commit/af60c123f385362fccd86f2e10efe986202e72c5))

## [4.3.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.3.0...v4.3.1) (2026-03-25)


### Bug Fixes

* add prepare script so git installs build dist ([e25019e](https://github.com/victor-software-house/pi-openai-proxy/commit/e25019e2f7de40c9e0c5a0d29cc67f25d583848e))

# [4.3.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.6...v4.3.0) (2026-03-25)


### Features

* **ext:** add /proxy models command to list exposed models with public IDs ([6168b45](https://github.com/victor-software-house/pi-openai-proxy/commit/6168b4564862658c3666d5797799288cb5137208))

## [4.2.6](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.5...v4.2.6) (2026-03-25)


### Bug Fixes

* use true/false for model selector toggle values ([755ad28](https://github.com/victor-software-house/pi-openai-proxy/commit/755ad28c039e8f1e5f8bfcd6395d096dad900870))

## [4.2.5](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.4...v4.2.5) (2026-03-25)


### Bug Fixes

* use on/off values for model selector toggle ([7305d4e](https://github.com/victor-software-house/pi-openai-proxy/commit/7305d4e9f82fb03993e29ecf0cdd1d9d7b4b1e3e))

## [4.2.4](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.3...v4.2.4) (2026-03-25)


### Bug Fixes

* use SettingsList for model selector, add provider jumping ([0b5a342](https://github.com/victor-software-house/pi-openai-proxy/commit/0b5a3424f3756492c75cb462779673c9c1399a46))

## [4.2.3](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.2...v4.2.3) (2026-03-25)


### Bug Fixes

* rewrite model selector with proper keybindings and provider jumping ([95598ad](https://github.com/victor-software-house/pi-openai-proxy/commit/95598ad03003731cd64a52f619cbefcd8d9652eb))

## [4.2.2](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.1...v4.2.2) (2026-03-25)


### Bug Fixes

* rewrite model selector as SettingsList ([d68c853](https://github.com/victor-software-house/pi-openai-proxy/commit/d68c853886432a06b9a83cdd2a7178cfa4791bd6))

## [4.2.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.2.0...v4.2.1) (2026-03-25)


### Bug Fixes

* wrap around arrow keys in model selector submenu ([340e173](https://github.com/victor-software-house/pi-openai-proxy/commit/340e173af36c5085142ac37f3a4f8a4254ba6db6))

# [4.2.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.1.0...v4.2.0) (2026-03-25)


### Features

* add /proxy restart command ([66fa02f](https://github.com/victor-software-house/pi-openai-proxy/commit/66fa02f89d336d2d48acaff457ef9e542072235a))

# [4.1.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.6...v4.1.0) (2026-03-25)


### Features

* hot-reload exposure config from file on each request ([3409d52](https://github.com/victor-software-house/pi-openai-proxy/commit/3409d5254ca3e3f9e3bbb87caa6d850ff1892836))
* hot-reload model exposure config without proxy restart ([a0e444b](https://github.com/victor-software-house/pi-openai-proxy/commit/a0e444be7f73dfb495521d1f8897d35ca64250d6))

## [4.0.6](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.5...v4.0.6) (2026-03-25)


### Bug Fixes

* improve settings panel with dynamic descriptions and clearer labels ([88f8b9f](https://github.com/victor-software-house/pi-openai-proxy/commit/88f8b9f9bfc67d9a1c4929d60ce65a0209fe4a3d))

## [4.0.5](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.4...v4.0.5) (2026-03-25)


### Bug Fixes

* make tests deterministic by removing loadConfig() dependency ([1cc1026](https://github.com/victor-software-house/pi-openai-proxy/commit/1cc10264ca83570c515a3fa9cadc80b92bbd015b))
* restore local dist/ as first proxy binary lookup path ([d25b9d0](https://github.com/victor-software-house/pi-openai-proxy/commit/d25b9d01e457a5de645492c37a8085d3d0edc103))

## [4.0.4](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.3...v4.0.4) (2026-03-25)


### Bug Fixes

* separate CI tests from SDK conformance tests ([cf6b401](https://github.com/victor-software-house/pi-openai-proxy/commit/cf6b4019e479b71a6808cb89de1036206ada1e0c))

## [4.0.3](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.2...v4.0.3) (2026-03-25)


### Bug Fixes

* promote all warn-level lint rules to error ([32988b5](https://github.com/victor-software-house/pi-openai-proxy/commit/32988b58acd08042c5594484c82cdb3b1fb99d01))

## [4.0.2](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.1...v4.0.2) (2026-03-25)


### Bug Fixes

* promote noUnusedVariables from warn to error in biome config ([808926e](https://github.com/victor-software-house/pi-openai-proxy/commit/808926e6172abc529b714e369e79b02361a0651c))
* remove unused getUniqueProviders function from extension ([a6710bc](https://github.com/victor-software-house/pi-openai-proxy/commit/a6710bc18a175c9f2f97f9a70f292de50298be73))

## [4.0.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v4.0.0...v4.0.1) (2026-03-25)


### Bug Fixes

* remove unused TINY_PNG constant from security tests ([658d2fd](https://github.com/victor-software-house/pi-openai-proxy/commit/658d2fdba6bfbc8cc3cac30d77a24a3285b69718))

# [4.0.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v3.0.0...v4.0.0) (2026-03-25)


* fix!: redesign model exposure UX and fix settings panel selection reset ([787624c](https://github.com/victor-software-house/pi-openai-proxy/commit/787624c21a80d182a5bbabc58d113cac4b7fcd76))


### BREAKING CHANGES

* default modelExposureMode changed from 'all' to 'scoped'.
The 'scoped' mode now means 'use pi's available (auth-configured) models'
which was the previous 'all' behavior. The 'all' mode now exposes all
registered models regardless of auth status.

Settings panel fixes:
- Fix selection jumping to first item on every value change: use
  SettingsList.updateValue() instead of rebuilding the entire list
- Remove scopedProviders, customModels, providerPrefixes as separate
  top-level settings items
- Single 'Exposure mode' enum: scoped (default), all, custom
- 'Select models' item with submenu for interactive model selection
  when exposure mode is 'custom'

Model-exposure engine:
- computeModelExposure() now accepts both available and allRegistered
  model arrays
- 'scoped' mode uses available (auth-filtered) models
- 'all' mode uses all registered models
- 'custom' mode filters available by canonical ID allowlist

# [3.0.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v2.1.0...v3.0.0) (2026-03-25)


* fix!: redesign model exposure UX and fix settings panel selection reset ([97db649](https://github.com/victor-software-house/pi-openai-proxy/commit/97db64961372206d732e64fbc0fa5b8ece26e90c))


### BREAKING CHANGES

* default modelExposureMode changed from 'all' to 'scoped'.
The 'scoped' mode now means 'use pi's available (auth-configured) models'
which was the previous 'all' behavior. The 'all' mode now exposes all
registered models regardless of auth status.

Settings panel fixes:
- Fix selection jumping to first item on every value change: use
  SettingsList.updateValue() instead of rebuilding the entire list
- Remove scopedProviders, customModels, providerPrefixes as separate
  top-level settings items (confusing toggle UX)
- Single 'Exposure mode' enum: scoped (default), all, custom
- 'Select models' item with submenu that opens an interactive model
  selector checklist when exposure mode is 'custom'
- Model selector supports arrow keys, Space to toggle, Esc to close

Model-exposure engine:
- computeModelExposure() now accepts both available and allRegistered
  model arrays
- 'scoped' mode uses available (auth-filtered) models
- 'all' mode uses all registered models
- 'custom' mode filters available by canonical ID allowlist

Config schema:
- Default modelExposureMode changed to 'scoped'
- scopedProviders field retained for backward compat but unused

# [2.1.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v2.0.0...v2.1.0) (2026-03-24)


### Features

* add /proxy verify, exposure settings panel, and public ID preview ([ac13313](https://github.com/victor-software-house/pi-openai-proxy/commit/ac13313dcad594a3a685e23e05605f1186916751))

# [2.0.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v1.0.0...v2.0.0) (2026-03-24)


* feat!: add model exposure engine with configurable public IDs and filtering ([82f866c](https://github.com/victor-software-house/pi-openai-proxy/commit/82f866c6d8f65fd9fb9bb26298dc9f79df8d952d))


### BREAKING CHANGES

* /v1/models and /v1/models/{model} no longer include x_pi
metadata. Model objects now follow the standard OpenAI shape only.

Model exposure engine (src/openai/model-exposure.ts):
- Three public ID modes: collision-prefixed (default), universal,
  always-prefixed
- Three exposure modes: all (default), scoped, custom
- Connected conflict group detection via Union-Find for
  collision-prefixed mode
- Provider prefix label overrides with uniqueness validation
- Universal mode collision detection with explicit config errors
- Resolution: public ID match -> canonical ID fallback (exposed only)
- Hidden models cannot be reached through canonical fallback

Config schema extended with:
- publicModelIdMode, modelExposureMode, scopedProviders, customModels,
  providerPrefixes
- Type guards for enum validation (no unsafe assertions)
- Normalization for string arrays and string records from JSON

Server integration:
- All three endpoints (GET /v1/models, GET /v1/models/{model},
  POST /v1/chat/completions) route through the shared exposure engine
- Replaces direct registry lookup and shorthand resolution

Compatibility refresh:
- reasoning_effort expanded: none, minimal, low, medium, high, xhigh
- response_format: added json_schema variant alongside text and
  json_object
- Reasoning effort mapping: none -> minimal, xhigh -> xhigh

Tests:
- 29 new unit tests for exposure engine covering all modes, conflict
  groups, prefix validation, resolution, and edge cases
- Updated integration tests for exposure-based resolution
- 4 new validation tests for expanded reasoning_effort and json_schema

# [1.0.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.3.1...v1.0.0) (2026-03-23)


* feat!: restructure as Bun workspace monorepo (Phase 4) ([5f7a690](https://github.com/victor-software-house/pi-openai-proxy/commit/5f7a6904bef4d6dfe2bdb5d5c3e7c507cbd8e06b))


### Bug Fixes

* resolve tsconfig lib/types for monorepo packages ([9770dbc](https://github.com/victor-software-house/pi-openai-proxy/commit/9770dbc5875e1f5557802deb678045bf2d39ef33))
* restore ES2023 lib in proxy tsconfig for editor compatibility ([ad554a7](https://github.com/victor-software-house/pi-openai-proxy/commit/ad554a7bdb8eb2685d35a89091a5630c086bf409))
* update lefthook and CI for monorepo ([4759525](https://github.com/victor-software-house/pi-openai-proxy/commit/4759525670a1ec8b8e862a12e1d9d7e54e5064b2))


### BREAKING CHANGES

* Package split into two packages.

Monorepo structure:
  packages/proxy/         pi-proxy (standalone CLI + HTTP server)
  packages/pi-extension/  @pi-openai-proxy/pi-extension (pi package)

pi-proxy changes:
- Proper CLI with citty (--host, --port, --auth-token, --config, --help)
- Config priority: CLI args > env vars > JSON file > defaults
- Config schema in src/config/schema.ts, exported via pi-proxy/config (SSOT)
- Binary renamed to pi-proxy, shebang #!/usr/bin/env bun
- ServerConfig replaces ProxyConfig in server internals
- @sinclair/typebox added to dependencies

@pi-openai-proxy/pi-extension changes:
- Imports config from pi-proxy/config (zero duplication)
- pi-proxy as workspace dependency, pi core as peerDependencies

Workspace:
- Bun workspaces + turborepo
- Shared tsconfig.base.json, biome at root, oxlint per-package

## [0.3.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.3.0...v0.3.1) (2026-03-23)


### Bug Fixes

* type errors in extension, add Phase 4 (config + pi-maestro) to roadmap ([bcaa761](https://github.com/victor-software-house/pi-openai-proxy/commit/bcaa761d67dcb5d4a9c7f3a9dc20c5ad1db58bbb))

# [0.3.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.2.3...v0.3.0) (2026-03-23)


### Features

* configurable proxy lifetime (detached or session-tied) ([036b534](https://github.com/victor-software-house/pi-openai-proxy/commit/036b53413c090eef560212899dfb7bfe99a28bf3))

## [0.2.3](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.2.2...v0.2.3) (2026-03-23)


### Bug Fixes

* remove undiscoverable --proxy flag, keep config panel ([27c2b92](https://github.com/victor-software-house/pi-openai-proxy/commit/27c2b92777e1eb47c9edb0943a00040c4874e0df))

## [0.2.2](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.2.1...v0.2.2) (2026-03-23)


### Bug Fixes

* show auth token on generate, improve /proxy show and docs ([99ebaaf](https://github.com/victor-software-house/pi-openai-proxy/commit/99ebaaf558963d030d514b049f83bd0195bda1a3))

## [0.2.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.2.0...v0.2.1) (2026-03-23)


### Bug Fixes

* rebuild SettingsList on change instead of calling nonexistent setItems ([bc140b0](https://github.com/victor-software-house/pi-openai-proxy/commit/bc140b0a37e460dc3dd0e06307289df179d79816))

# [0.2.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.1.1...v0.2.0) (2026-03-23)


### Features

* add /proxy config panel and improve documentation ([0abff00](https://github.com/victor-software-house/pi-openai-proxy/commit/0abff00b265f724ea2b5881b16a9f12005f0ca70))

## [0.1.1](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.1.0...v0.1.1) (2026-03-23)


### Bug Fixes

* use correct notification level 'warning' in proxy extension ([ca1a579](https://github.com/victor-software-house/pi-openai-proxy/commit/ca1a579ddf5fa682d079ad07f63635ddf22c8f5d))

# [0.1.0](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.0.3...v0.1.0) (2026-03-23)


### Features

* add pi extension with /proxy command and --proxy flag ([6ce2bd2](https://github.com/victor-software-house/pi-openai-proxy/commit/6ce2bd2cdeacb06fa76803bd69f030051388d369))

## [0.0.3](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.0.2...v0.0.3) (2026-03-23)


### Bug Fixes

* add pi-package keyword ([693aeea](https://github.com/victor-software-house/pi-openai-proxy/commit/693aeea406fe0048d101946e1a8adca5146fb08e))

## [0.0.2](https://github.com/victor-software-house/pi-openai-proxy/compare/v0.0.1...v0.0.2) (2026-03-23)


### Bug Fixes

* add LICENSE, fix CI test and publish workflow, fix start script path ([0c56796](https://github.com/victor-software-house/pi-openai-proxy/commit/0c56796c6fcdc519c2af0201f29ed9f5f4ad2bd3))
