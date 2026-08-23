import axios from 'axios';

/**
 * 获取 GitHub Repo 的 README.md
 */
export async function fetchGithubReadme(apiUrl: string): Promise<string> {
  try {
    console.log(`[Scraper] 正在从 GitHub 获取: ${apiUrl}`);
    const res = await axios.get(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3.raw',
        // 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` // 如果有的话
      }
    });
    return res.data;
  } catch (err: any) {
    console.error(`❌ [Scraper] GitHub 抓取失败:`, err.message);
    throw err;
  }
}
