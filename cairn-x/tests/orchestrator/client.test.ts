import { inspectClientProject } from "../support/project-state.js";
import { describe, expect, it } from "vitest";

import { ClientError, FgsClient } from "../../src/orchestrator/client.js";
import { addStep, createProject, startTestServer } from "./helpers.js";

describe("FgsClient", () => {
	it("lists scheduling project availability", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		const summaries = await client.listSchedulingProjects();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			id: pid,
			status: "active",
			decide_worker: null,
			has_open_steps: true,
			has_claimed_steps: false,
		});
	});

	it("gets a bounded overview and complete single records", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client, { goal: "find the flag" });
		const overview = await client.getProjectOverview(pid);
		expect(overview.project.id).toBe(pid);
		expect(overview.counts.facts).toBe(1);
		expect(await client.getRecord(pid, "fact", "origin")).toMatchObject({ id: "origin" });
		expect(await client.getRecord(pid, "goal", "goal")).toMatchObject({
			id: "goal",
			description: "find the flag",
		});
	});

	it("reads and updates settings", async () => {
		const { client } = await startTestServer();
		const settings = await client.getSettings();
		expect(settings.lease_timeout).toBeGreaterThan(0);
		const updated = await client.updateSettings({ lease_timeout: 30 });
		expect(updated.ok).toBe(true);
		expect((await client.getSettings()).lease_timeout).toBe(30);
	});

	it("claims, heartbeats, concludes and releases steps with status-code control flow", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		const sid = await addStep(client, pid);

		const claim = await client.claimStep(pid, sid, "w1");
		expect(claim.ok).toBe(true);
		expect(claim.data).toMatchObject({ status: "claimed", worker: "w1" });

		const conflict = await client.claimStep(pid, sid, "w2");
		expect(conflict.ok).toBe(false);
		expect(conflict.statusCode).toBe(409);

		const foreignRelease = await client.releaseStep(pid, sid, "w2");
		expect(foreignRelease.statusCode).toBe(409);

		const conclude = await client.concludeStep(pid, sid, "w1", "done");
		expect(conclude.ok).toBe(true);
		expect(conclude.data?.step.summary).toBe("done");

		const reconclude = await client.concludeStep(pid, sid, "w1", "again");
		expect(reconclude.statusCode).toBe(409);
	});

	it("releases a claimed step back to open", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		const sid = await addStep(client, pid);
		await client.claimStep(pid, sid, "w1");
		const release = await client.releaseStep(pid, sid, "w1");
		expect(release.ok).toBe(true);
		expect(release.data).toMatchObject({ status: "open", worker: null });
	});

	it("abandons steps and updates priority", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		const sid = await addStep(client, pid);
		const prio = await client.setStepPriority(pid, sid, 7, { actor: "human" });
		expect(prio.ok).toBe(true);
		expect(prio.data?.priority).toBe(7);
		const abandon = await client.abandonStep(pid, sid, "w1", "obsolete");
		// w1 既未认领该 step，也不持有 decide lease -> 409
		expect(abandon.statusCode).toBe(409);
		await client.claimStep(pid, sid, "w1");
		const abandoned = await client.abandonStep(pid, sid, "w1", "obsolete");
		expect(abandoned.ok).toBe(true);
		expect(abandoned.data?.status).toBe("abandoned");
	});

	it("manages goals: create, achieve, delete", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		const goal = await client.createGoal(pid, { actor: "human", description: "sub goal" });
		expect(goal.statusCode).toBe(201);
		const gid = goal.data!.id;
		const achieve = await client.achieveGoal(pid, gid, {
			from: [{ type: "fact", id: "origin" }],
			description: "done",
			actor: "human",
		});
		expect(achieve.ok).toBe(true);
		expect(achieve.data?.status).toBe("achieved");
		const del = await client.deleteGoal(pid, gid, { actor: "human" });
		expect(del.statusCode).toBe(409); // 已达成的 goal 不能删除
		const delRoot = await client.deleteGoal(pid, "goal", { actor: "human" });
		expect(delRoot.statusCode).toBe(400);
	});

	it("creates facts, findings and hints", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client, { hints: [{ content: "h0", creator: "human" }] });
		const fact = await client.createFact(pid, {
			confidence: "observed",
			actor: "human",
			description: "new fact",
		});
		expect(fact.statusCode).toBe(201);
		const finding = await client.createFinding(pid, {
			actor: "human",
			title: "vuln",
			description: "xss",
			data: { severity: "high" },
			fact_ids: ["origin"],
		});
		expect(finding.statusCode).toBe(201);
		expect(finding.data?.fact_ids).toEqual(["origin"]);
		const hint = await client.createHint(pid, { content: "h1", creator: "human" });
		expect(hint.statusCode).toBe(201);
		const detail = await inspectClientProject(client, pid);
		expect(detail.findings).toHaveLength(1);
		expect(detail.hints).toHaveLength(2);
	});

	it("runs the decide lease lifecycle with 409 conflicts", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		const claim = await client.claimDecide(pid, "w1");
		expect(claim.ok).toBe(true);
		expect(claim.data?.decide?.worker).toBe("w1");

		const conflict = await client.claimDecide(pid, "w2");
		expect(conflict.statusCode).toBe(409);

		const foreignHeartbeat = await client.heartbeatDecide(pid, "w2");
		expect(foreignHeartbeat.statusCode).toBe(409);

		const heartbeat = await client.heartbeatDecide(pid, "w1");
		expect(heartbeat.ok).toBe(true);

		const foreignRelease = await client.releaseDecide(pid, "w2");
		expect(foreignRelease.statusCode).toBe(409);

		const release = await client.releaseDecide(pid, "w1");
		expect(release.ok).toBe(true);
		expect(release.data?.decide).toBeNull();

		const heartbeatAfterRelease = await client.heartbeatDecide(pid, "w1");
		expect(heartbeatAfterRelease.statusCode).toBe(409);
	});

	it("changes project status and completes projects", async () => {
		const { client } = await startTestServer();
		const pid = await createProject(client);
		const stopped = await client.setProjectStatus(pid, "stopped");
		expect(stopped.ok).toBe(true);
		expect(stopped.data?.status).toBe("stopped");
		const blockedWrite = await client.createFact(pid, {
			confidence: "observed",
			actor: "human",
			description: "nope",
		});
		expect(blockedWrite.statusCode).toBe(403);
		await client.setProjectStatus(pid, "active");
		const completed = await client.completeProject(pid, {
			from: [{ type: "fact", id: "origin" }],
			description: "done",
			actor: "human",
		});
		expect(completed.ok).toBe(true);
		const restop = await client.setProjectStatus(pid, "stopped");
		expect(restop.statusCode).toBe(409);
	});

	it("surfaces 404 on read as ClientError", async () => {
		const { client } = await startTestServer();
		await expect(client.getProjectOverview("proj_999")).rejects.toMatchObject({
			name: "ClientError",
			statusCode: 404,
		});
	});

	it("returns statusCode 0 on network errors and throws on GET", async () => {
		const server = await startTestServer();
		const url = server.url;
		await server.close();
		const client = new FgsClient(url);
		const result = await client.claimStep("proj_001", "s001", "w1");
		expect(result.ok).toBe(false);
		expect(result.statusCode).toBe(0);
		expect(result.text).not.toBe("");
		await expect(client.listSchedulingProjects()).rejects.toBeInstanceOf(ClientError);
	});
});
