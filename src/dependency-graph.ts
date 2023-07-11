import * as core from '@actions/core'
import * as artifact from '@actions/artifact'
import * as github from '@actions/github'
import * as glob from '@actions/glob'
import * as toolCache from '@actions/tool-cache'
import {Octokit} from '@octokit/rest'

import * as path from 'path'
import fs from 'fs'

import * as layout from './repository-layout'
import {DependencyGraphOption, getJobMatrix} from './input-params'

const DEPENDENCY_GRAPH_ARTIFACT = 'dependency-graph'

export function setup(option: DependencyGraphOption): void {
    if (option === DependencyGraphOption.Disabled || option === DependencyGraphOption.DownloadAndSubmit) {
        return
    }

    core.info('Enabling dependency graph generation')
    const jobCorrelator = getJobCorrelator()
    core.exportVariable('GITHUB_DEPENDENCY_GRAPH_ENABLED', 'true')
    core.exportVariable('GITHUB_DEPENDENCY_GRAPH_JOB_CORRELATOR', jobCorrelator)
    core.exportVariable('GITHUB_DEPENDENCY_GRAPH_JOB_ID', github.context.runId)
    core.exportVariable(
        'GITHUB_DEPENDENCY_GRAPH_REPORT_DIR',
        path.resolve(layout.workspaceDirectory(), 'dependency-graph-reports')
    )
}

export async function complete(option: DependencyGraphOption): Promise<void> {
    switch (option) {
        case DependencyGraphOption.Disabled:
            return
        case DependencyGraphOption.Generate:
            await uploadDependencyGraphs()
            return
        case DependencyGraphOption.GenerateAndSubmit:
            await submitDependencyGraphs(await uploadDependencyGraphs())
            return
        case DependencyGraphOption.DownloadAndSubmit:
            await downloadAndSubmitDependencyGraphs()
    }
}

async function uploadDependencyGraphs(): Promise<string[]> {
    const workspaceDirectory = layout.workspaceDirectory()
    const graphFiles = await findDependencyGraphFiles(workspaceDirectory)

    const relativeGraphFiles = graphFiles.map(x => getRelativePathFromWorkspace(x))
    core.info(`Uploading dependency graph files: ${relativeGraphFiles}`)

    const artifactClient = artifact.create()
    artifactClient.uploadArtifact(DEPENDENCY_GRAPH_ARTIFACT, graphFiles, workspaceDirectory)

    return graphFiles
}

async function downloadAndSubmitDependencyGraphs(): Promise<void> {
    const workspaceDirectory = layout.workspaceDirectory()
    submitDependencyGraphs(await retrieveDependencyGraphs(workspaceDirectory))
}

async function submitDependencyGraphs(dependencyGraphFiles: string[]): Promise<void> {
    const octokit: Octokit = getOctokit()

    for (const jsonFile of dependencyGraphFiles) {
        const jsonContent = fs.readFileSync(jsonFile, 'utf8')

        const jsonObject = JSON.parse(jsonContent)
        jsonObject.owner = github.context.repo.owner
        jsonObject.repo = github.context.repo.repo
        const response = await octokit.request('POST /repos/{owner}/{repo}/dependency-graph/snapshots', jsonObject)

        const relativeJsonFile = getRelativePathFromWorkspace(jsonFile)
        core.notice(`Submitted ${relativeJsonFile}: ${response.data.message}`)
    }
}

async function retrieveDependencyGraphs(workspaceDirectory: string): Promise<string[]> {
    if (github.context.payload.workflow_run) {
        return await retrieveDependencyGraphsForWorkflowRun(github.context.payload.workflow_run.id, workspaceDirectory)
    }
    return retrieveDependencyGraphsForCurrentWorkflow(workspaceDirectory)
}

async function retrieveDependencyGraphsForWorkflowRun(runId: number, workspaceDirectory: string): Promise<string[]> {
    const octokit: Octokit = getOctokit()

    // Find the workflow run artifacts named "dependency-graph"
    const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        run_id: runId
    })

    const matchArtifact = artifacts.data.artifacts.find(candidate => {
        return candidate.name === DEPENDENCY_GRAPH_ARTIFACT
    })

    if (matchArtifact === undefined) {
        throw new Error(`Dependency graph artifact not found. Has it been generated by workflow run '${runId}'?`)
    }

    // Download the dependency-graph artifact
    const download = await octokit.rest.actions.downloadArtifact({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        artifact_id: matchArtifact.id,
        archive_format: 'zip'
    })

    const downloadBuffer = download.data as ArrayBuffer
    const downloadZip = path.resolve(workspaceDirectory, 'dependency-graph.zip')
    fs.writeFileSync(downloadZip, Buffer.from(downloadBuffer))

    // Expance the dependency-graph zip and locate each dependency-graph JSON file
    const extractDir = path.resolve(workspaceDirectory, 'dependency-graph')
    const extracted = await toolCache.extractZip(downloadZip, extractDir)
    core.info(`Extracted dependency graph artifacts to ${extracted}: ${fs.readdirSync(extracted)}`)

    return findDependencyGraphFiles(extracted)
}

async function retrieveDependencyGraphsForCurrentWorkflow(workspaceDirectory: string): Promise<string[]> {
    const artifactClient = artifact.create()
    const downloadPath = path.resolve(workspaceDirectory, 'dependency-graph')
    await artifactClient.downloadArtifact(DEPENDENCY_GRAPH_ARTIFACT, downloadPath)
    return await findDependencyGraphFiles(downloadPath)
}

async function findDependencyGraphFiles(dir: string): Promise<string[]> {
    const globber = await glob.create(`${dir}/dependency-graph-reports/*.json`)
    const graphFiles = globber.glob()
    return graphFiles
}

function getOctokit(): Octokit {
    return new Octokit({
        auth: getGithubToken()
    })
}

function getGithubToken(): string {
    return core.getInput('github-token', {required: true})
}

function getRelativePathFromWorkspace(file: string): string {
    const workspaceDirectory = layout.workspaceDirectory()
    return path.relative(workspaceDirectory, file)
}

export function getJobCorrelator(): string {
    return constructJobCorrelator(github.context.workflow, github.context.job, getJobMatrix())
}

export function constructJobCorrelator(workflow: string, jobId: string, matrixJson: string): string {
    const matrixString = describeMatrix(matrixJson)
    const label = matrixString ? `${workflow}-${jobId}-${matrixString}` : `${workflow}-${jobId}`
    return sanitize(label)
}

function describeMatrix(matrixJson: string): string {
    core.debug(`Got matrix json: ${matrixJson}`)
    const matrix = JSON.parse(matrixJson)
    if (matrix) {
        return Object.values(matrix).join('-')
    }
    return ''
}

function sanitize(value: string): string {
    return value
        .replace(/[^a-zA-Z0-9_-\s]/g, '')
        .replace(/\s+/g, '_')
        .toLowerCase()
}