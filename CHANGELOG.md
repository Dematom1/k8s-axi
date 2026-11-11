# Changelog

## [0.1.4](https://github.com/Dematom1/k8s-axi/compare/k8s-axi-v0.1.3...k8s-axi-v0.1.4) (2026-11-11)


### Bug Fixes

* **cli:** prioritize help and add structured list totals ([#20](https://github.com/Dematom1/k8s-axi/issues/20)) ([717c0a9](https://github.com/Dematom1/k8s-axi/commit/717c0a964660f2ef8b551a237ddbd5173f0f948c))

## [0.1.3](https://github.com/Dematom1/k8s-axi/compare/k8s-axi-v0.1.2...k8s-axi-v0.1.3) (2026-11-10)


### Features

* **actions:** add guarded Kubernetes action foundation ([#10](https://github.com/Dematom1/k8s-axi/issues/10)) ([1faf2a3](https://github.com/Dematom1/k8s-axi/commit/1faf2a34ba3e4a0df43cb46d2df6340e9ef653c2))
* **cli:** add named views for Kubernetes resources ([#15](https://github.com/Dematom1/k8s-axi/issues/15)) ([6112884](https://github.com/Dematom1/k8s-axi/commit/6112884d0b33fdb281ba14756e7aaeb8c2ef3ae1))
* **cli:** improve Kubernetes log output ([#13](https://github.com/Dematom1/k8s-axi/issues/13)) ([df6eec2](https://github.com/Dematom1/k8s-axi/commit/df6eec27e16df2fcba92bf11ffad0ee607447530))
* **cli:** support common kubectl read commands ([#7](https://github.com/Dematom1/k8s-axi/issues/7)) ([55b4b83](https://github.com/Dematom1/k8s-axi/commit/55b4b83ced891fba6b2c0e8c4d238b3d902e1728))
* **lab:** lease live kind clusters through berth ([#17](https://github.com/Dematom1/k8s-axi/issues/17)) ([bc621d1](https://github.com/Dematom1/k8s-axi/commit/bc621d1e802f35a2ec0954c063c509db0ef8757e))


### Bug Fixes

* **pods:** surface crash-looping pods immediately ([#6](https://github.com/Dematom1/k8s-axi/issues/6)) ([8343794](https://github.com/Dematom1/k8s-axi/commit/83437944d1e65904d1aedb4861b178d5a2a7c8fc))

## [0.1.2](https://github.com/Dematom1/k8s-axi/compare/k8s-axi-v0.1.1...k8s-axi-v0.1.2) (2026-11-08)


### Features

* **actions:** add guarded Kubernetes action foundation ([#10](https://github.com/Dematom1/k8s-axi/issues/10)) ([1faf2a3](https://github.com/Dematom1/k8s-axi/commit/1faf2a34ba3e4a0df43cb46d2df6340e9ef653c2))
* **cli:** add named views for Kubernetes resources ([#15](https://github.com/Dematom1/k8s-axi/issues/15)) ([6112884](https://github.com/Dematom1/k8s-axi/commit/6112884d0b33fdb281ba14756e7aaeb8c2ef3ae1))
* **cli:** support common kubectl read commands ([#7](https://github.com/Dematom1/k8s-axi/issues/7)) ([55b4b83](https://github.com/Dematom1/k8s-axi/commit/55b4b83ced891fba6b2c0e8c4d238b3d902e1728))


### Bug Fixes

* **claude:** honor CLAUDE_CONFIG_DIR for hooks ([#9](https://github.com/Dematom1/k8s-axi/issues/9)) ([b9c4f39](https://github.com/Dematom1/k8s-axi/commit/b9c4f395e47aba71e1868fb6e5d62ad6dd90f6ae))
* **pods:** surface crash-looping pods immediately ([#6](https://github.com/Dematom1/k8s-axi/issues/6)) ([8343794](https://github.com/Dematom1/k8s-axi/commit/83437944d1e65904d1aedb4861b178d5a2a7c8fc))

## [0.1.1](https://github.com/Dematom1/k8s-axi/compare/k8s-axi-v0.1.0...k8s-axi-v0.1.1) (2026-11-04)


### Features

* **args:** validate inputs and refuse every unsafe command ([9585250](https://github.com/Dematom1/k8s-axi/commit/9585250842e201fda2998304a9cd0558aaef578e))
* **events:** resolve event times, filter and redact messages ([941ab84](https://github.com/Dematom1/k8s-axi/commit/941ab8423caa3e06a759cd275a9214590aba9061))
* **hooks:** add explicit local-only hooks and session memory ([2585557](https://github.com/Dematom1/k8s-axi/commit/258555796ac7adad41e8648e50d12e558c53f98b))
* **logs:** bound and redact non-streaming pod logs ([031180e](https://github.com/Dematom1/k8s-axi/commit/031180ec859bb8dca82447876c9b9ef2318c9294))
* **nodes:** add bounded list renderer and node diagnostics ([1c76d34](https://github.com/Dematom1/k8s-axi/commit/1c76d345786ee15578baf59473230f06837ebf32))
* **pods:** diagnose readiness and project safe pod details ([07d7b1b](https://github.com/Dematom1/k8s-axi/commit/07d7b1b31d0469aa01053c5b149a902a9224b131))
* **scaffold:** add packaged AXI entrypoint and checks ([e3bbaff](https://github.com/Dematom1/k8s-axi/commit/e3bbaffcf45efa2947eaba3d9157888aef98db2b))
* **secrets:** project metadata and keys through a fixed template ([48c524a](https://github.com/Dematom1/k8s-axi/commit/48c524a47bd79a9c17da147c00a98d48bd11bd88))
* **target:** pin context and verify namespace scope ([d4ea921](https://github.com/Dematom1/k8s-axi/commit/d4ea9213254eb3ec2e5b30449668ce062a3f466e))
* **transport:** constrain reads, deadlines, output and redaction ([b503617](https://github.com/Dematom1/k8s-axi/commit/b503617278aa58c8bc6df72cd4bb1938d08feec4))
* **triage:** derive truthful health from seven completed checks ([863a644](https://github.com/Dematom1/k8s-axi/commit/863a64481c76950ebc25927555a509f49d91d235))
* **workloads:** add deployments jobs PVCs and EndpointSlice joins ([bd714b8](https://github.com/Dematom1/k8s-axi/commit/bd714b812526a77c1b4d26ffad80efcc7d47e054))


### Bug Fixes

* **setup:** repair duplicate and stale managed hooks ([#5](https://github.com/Dematom1/k8s-axi/issues/5)) ([1e32be4](https://github.com/Dematom1/k8s-axi/commit/1e32be45899f304fc106b26fd1ae38e916103f9d))
