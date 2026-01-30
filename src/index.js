export default {
  async fetch(request, env, ctx) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
      'X-Worker-Version': env.CF_VERSION.id,
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('', { headers: corsHeaders });
    }

    try {
      // Only accept POST requests
      if (request.method !== 'POST') {
        return new Response(
          JSON.stringify({ error: 'Method not allowed. Use POST.' }),
          { status: 405, headers: corsHeaders }
        );
      }


      // Parse request body
      const body = await request.json();
      const { release_tag, pr_numbers, repo_owner = 'esphome', repo_name = 'esphome' } = body;

      if (!release_tag || !pr_numbers || !Array.isArray(pr_numbers)) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: release_tag and pr_numbers (array)' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Get GitHub token from environment if available
      const githubToken = env.GITHUB_TOKEN;

      // Process each PR
      const results = {};
      for (const prNumber of pr_numbers) {
        results[prNumber] = await checkPRInRelease(
          env.PR_CACHE,
          repo_owner,
          repo_name,
          prNumber,
          release_tag,
          githubToken
        );
      }

      return new Response(JSON.stringify(results, null, 2), { headers: corsHeaders });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message, stack: error.stack }),
        { status: 500, headers: corsHeaders }
      );
    }
  },
};


async function checkPRInRelease(kv, repoOwner, repoName, prNumber, releaseTag, githubToken) {
  // Create cache key
  const cacheKey = `${repoOwner}/${repoName}/pr-${prNumber}/release-${releaseTag}`;

  // Check cache
  const cached = await kv.get(cacheKey);
  if (cached) {
    const cachedData = JSON.parse(cached);
    const cachedTime = new Date(cachedData.cached_at);
    const now = new Date();

    // If status is "merged", cache forever
    if (cachedData.status === 'merged') {
      return cachedData;
    }

    // If status is "not-yet" or checking a dev branch, check if cache expired (24 hours)
    if (cachedData.status === 'not-yet' || releaseTag.endsWith('dev')) {
      const hoursSinceCached = (now - cachedTime) / (1000 * 60 * 60);
      if (hoursSinceCached < 24) {
        return cachedData;
      }
      // Cache expired, continue to re-check
    }
  }

  // Cache miss or expired - fetch from GitHub
  const result = await fetchPRReleaseStatus(repoOwner, repoName, prNumber, releaseTag, githubToken);

  // Cache the result
  result.cached_at = new Date().toISOString();

  // Store in KV
  await kv.put(cacheKey, JSON.stringify(result));

  return result;
}

async function fetchPRReleaseStatus(repoOwner, repoName, prNumber, releaseTag, githubToken) {
  // Create headers
  const headers = {
    'User-Agent': 'Cloudflare-Worker-PR-Checker',
  };
  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  // Get PR details
  const prUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`;
  const prResponse = await fetch(prUrl, { headers });

  if (!prResponse.ok) {
    return {
      status: 'error',
      error: `Failed to fetch PR: ${prResponse.status}`,
      pr_number: prNumber,
      release_tag: releaseTag,
    };
  }

  const prData = await prResponse.json();

  // Check if PR is merged
  if (!prData.merged) {
    return {
      status: 'not-merged',
      pr_number: prNumber,
      release_tag: releaseTag,
      message: 'PR is not merged yet',
    };
  }

  const mergeCommitSha = prData.merge_commit_sha;

  // Determine if we're checking a tag or a branch
  const isDevBranch = releaseTag.endsWith('dev');
  let targetSha;
  let targetType;

  if (isDevBranch) {
    // Fetch branch SHA
    const branchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/git/ref/heads/dev`;
    const branchResponse = await fetch(branchUrl, { headers });

    if (!branchResponse.ok) {
      return {
        status: 'error',
        error: `Failed to fetch branch: ${branchResponse.status}`,
        pr_number: prNumber,
        release_tag: releaseTag,
      };
    }

    const branchData = await branchResponse.json();
    targetSha = branchData.object.sha;
    targetType = 'branch';
  } else {
    // Fetch tag SHA
    const tagUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/git/ref/tags/${releaseTag}`;
    const tagResponse = await fetch(tagUrl, { headers });

    if (!tagResponse.ok) {
      return {
        status: 'error',
        error: `Failed to fetch release tag: ${tagResponse.status}`,
        pr_number: prNumber,
        release_tag: releaseTag,
      };
    }

    const tagData = await tagResponse.json();
    targetSha = tagData.object.sha;
    targetType = 'tag';
  }

  // Compare head commit with target (tag or branch)
  const compareUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/compare/${mergeCommitSha}...${targetSha}`;
  const compareResponse = await fetch(compareUrl, { headers });

  if (!compareResponse.ok) {
    return {
      status: 'error',
      error: `Failed to compare commits: ${compareResponse.status}`,
      pr_number: prNumber,
      release_tag: releaseTag,
    };
  }

  const compareData = await compareResponse.json();

  // Check if head commit is in release
  const isInRelease = ['ahead', 'identical'].includes(compareData.status);
  let isCherryPicked = false;

  // 2. If not found by SHA, look for a "Patch Match" or "Message Match"
  if (!isInRelease) {
    const originalCommitMessage = prData.title; // Or fetch the actual original commit message
    
    isCherryPicked = compareData.commits.some(commit => {
      // Check if the message contains the original SHA (the -x flag behavior)
      const hasShaReference = commit.commit.message.includes(mergeCommitSha);
      
      // OR: Check if the commit message is identical (common in manual cherry-picks)
      const hasSameMessage = commit.commit.message.includes(originalCommitMessage);

      return hasShaReference || hasSameMessage;
    });
  }

  return {
    status: (isCherryPicked || isInRelease) ? 'merged' : 'not-yet',
    pr_number: prNumber,
    release_tag: releaseTag,
    target_type: targetType,
    merge_commit_sha: mergeCommitSha,
    pr_merged_at: prData.merged_at,
    is_in_release: isInRelease,
    is_cherry_picked: isCherryPicked,
  };
}
