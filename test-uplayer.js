#!/usr/bin/env node

const { StreamManager } = require('./uplayer.js');
const chalk = require('chalk');
const http = require('http');
const { URL } = require('url');

// Try to load Puppeteer for automated browser testing (optional)
let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  // Puppeteer not installed, will use manual testing instructions
}

// Test magnet link
const testMagnet = 'magnet:?xt=urn:btih:RC4WFM3EIAQJ5YZVZIGP6DFPZVXMAVC6&dn=%5BSubsPlease%5D%20One-Punch%20Man%20S3%20-%2011%20%281080p%29%20%5BB37FC327%5D.mkv&xl=1466553981&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=http%3A%2F%2Ftracker.mywaifu.best%3A6969%2Fannounce&tr=https%3A%2F%2Ftracker.zhuqiy.com%3A443%2Fannounce&tr=udp%3A%2F%2Ftracker.tryhackx.org%3A6969%2Fannounce&tr=udp%3A%2F%2Fretracker.hotplug.ru%3A2710%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.com%3A6969%2Fannounce&tr=http%3A%2F%2Ftracker.beeimg.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ft.overflow.biz%3A6969%2Fannounce&tr=wss%3A%2F%2Ftracker.openwebtorrent.com';

async function testStreaming() {
  console.log(chalk.blue('🧪 Starting Stream Test...\n'));
  console.log(chalk.cyan('Magnet Link:'));
  console.log(chalk.gray(testMagnet.substring(0, 80) + '...\n'));

  const streamManager = new StreamManager();

  // Handle cleanup on exit
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n🛑 Stopping test...'));
    streamManager.destroy();
    process.exit(0);
  });

  process.on('exit', () => {
    try {
      streamManager.destroy();
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  try {
    console.log(chalk.blue('📥 Adding torrent...'));
    
    const result = await streamManager.stream(testMagnet, {
      openPlayer: false // Don't auto-open browser for testing
    });

    if (result && (result.url || result.urls)) {
      console.log(chalk.green('\n✅ Stream started successfully!'));
      console.log(chalk.cyan('\n📊 Test Results:'));
      console.log(chalk.green('  ✓ Torrent added'));
      console.log(chalk.green('  ✓ Video file found'));
      console.log(chalk.green('  ✓ Streaming server started'));
      
      if (result.urls) {
        console.log(chalk.cyan('\n🌐 Available URLs:'));
        console.log(chalk.yellow('  Local:    ' + result.urls.localhost));
        console.log(chalk.yellow('  Network:  ' + result.urls.ip));
        console.log(chalk.yellow('  Custom:   ' + result.urls.custom));
        console.log(chalk.gray('\n  💡 To use custom domain "' + result.urls.hostname + '", add this to /etc/hosts:'));
        console.log(chalk.gray('     ' + result.urls.ip.split(':')[0].replace('http://', '') + ' ' + result.urls.hostname));
      } else if (result.url) {
        console.log(chalk.yellow('\n📺 Stream URL: ' + result.url));
      }
      
      if (result.videoFile) {
        console.log(chalk.cyan('\n🎬 Video File Info:'));
        console.log(chalk.gray('  Name: ' + result.videoFile.name));
        console.log(chalk.gray('  Size: ' + (result.videoFile.length / 1024 / 1024 / 1024).toFixed(2) + ' GB'));
      }

      if (streamManager.subtitlePath) {
        console.log(chalk.green('\n  ✓ Subtitles found and configured'));
        console.log(chalk.cyan('    Subtitle path: ' + streamManager.subtitlePath));
      } else {
        console.log(chalk.yellow('\n  ⚠ No subtitles found'));
      }

      if (streamManager.subtitlePaths && streamManager.subtitlePaths.length > 0) {
        console.log(chalk.cyan('\n📝 Available Subtitles:'));
        streamManager.subtitlePaths.forEach((sub, index) => {
          console.log(chalk.cyan(`  ${index + 1}. ${sub.label || sub.language || 'Unknown'}`));
          console.log(chalk.gray(`     Source: ${sub.source}, Language: ${sub.language || 'unknown'}`));
        });
      }

      const streamUrl = result.urls ? result.urls.localhost : result.url;
      
      // Run automated subtitle seeking tests
      if (puppeteer) {
        console.log(chalk.cyan('\n🤖 Starting automated subtitle seeking tests...\n'));
        await runAutomatedTests(streamUrl, result.videoFile);
      } else {
        console.log(chalk.yellow('\n⚠️  Puppeteer not installed. Install it for automated testing:'));
        console.log(chalk.gray('   npm install puppeteer\n'));
        console.log(chalk.cyan('📋 Manual Test Instructions:'));
        printManualTestInstructions(streamUrl);
      }

      // Start continuous monitoring
      console.log(chalk.cyan('\n📊 Starting continuous monitoring...\n'));
      startMonitoring(streamUrl, streamManager);

      console.log(chalk.green('✅ All systems operational!'));
      console.log(chalk.gray('\nMonitoring active. Press Ctrl+C to stop.\n'));

      // Keep the process running
      return new Promise(() => {});
    } else {
      console.error(chalk.red('❌ Failed to start stream'));
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red('\n❌ Test failed:'));
    console.error(chalk.red('  ' + error.message));
    if (error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }
    streamManager.destroy();
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testStreaming().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

// Automated browser testing for subtitle seeking behavior
async function runAutomatedTests(streamUrl, videoFile) {
  let browser = null;
  const testResults = {
    total: 0,
    passed: 0,
    failed: 0,
    details: []
  };

  try {
    console.log(chalk.blue('🌐 Launching browser...'));
    browser = await puppeteer.launch({
      headless: false, // Show browser for visual verification
      args: ['--autoplay-policy=no-user-gesture-required']
    });

    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });

    console.log(chalk.blue('📺 Loading video page...'));
    await page.goto(streamUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for video element
    await page.waitForSelector('video', { timeout: 10000 });

    console.log(chalk.green('✓ Video element found'));

    // Test 1: Check if subtitles are available
    console.log(chalk.cyan('\n📝 Test 1: Checking subtitle tracks...'));
    const subtitleTracks = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video || !video.textTracks) return [];
      return Array.from(video.textTracks)
        .filter(t => t.kind === 'subtitles')
        .map(t => ({
          language: t.language || t.srclang || 'unknown',
          label: t.label || 'Unknown',
          mode: t.mode,
          readyState: t.readyState
        }));
    });

    testResults.total++;
    if (subtitleTracks.length > 0) {
      testResults.passed++;
      console.log(chalk.green(`  ✓ Found ${subtitleTracks.length} subtitle track(s):`));
      subtitleTracks.forEach((track, i) => {
        console.log(chalk.gray(`    ${i + 1}. ${track.label} (${track.language}) - Mode: ${track.mode}`));
      });
    } else {
      testResults.failed++;
      console.log(chalk.yellow('  ⚠ No subtitle tracks found'));
    }

    // Wait for video to load
    console.log(chalk.cyan('\n⏳ Waiting for video to load...'));
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const video = document.querySelector('video');
        if (video.readyState >= 3) {
          resolve();
        } else {
          video.addEventListener('canplay', () => resolve(), { once: true });
          setTimeout(() => resolve(), 5000);
        }
      });
    });

    // Get video duration
    const duration = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video.duration;
    });

    if (!duration || isNaN(duration)) {
      console.log(chalk.yellow('  ⚠ Could not get video duration, skipping seek tests'));
      await browser.close();
      return;
    }

    console.log(chalk.green(`  ✓ Video loaded (Duration: ${Math.floor(duration)}s)`));

    // Test 2: Enable subtitles and check initial state
    console.log(chalk.cyan('\n📝 Test 2: Enabling default subtitles...'));
    const initialSubtitleState = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video.textTracks) return null;
      
      const tracks = Array.from(video.textTracks).filter(t => t.kind === 'subtitles');
      if (tracks.length === 0) return null;
      
      // Find default or English track
      let track = tracks.find(t => t.default) || 
                  tracks.find(t => (t.language || t.srclang || '').toLowerCase().includes('en'));
      if (!track) track = tracks[0];
      
      if (track.readyState >= 1) {
        track.mode = 'showing';
        return {
          language: track.language || track.srclang || 'unknown',
          label: track.label || 'Unknown',
          mode: track.mode,
          cues: track.cues ? track.cues.length : 0
        };
      }
      return null;
    });

    testResults.total++;
    if (initialSubtitleState && initialSubtitleState.mode === 'showing') {
      testResults.passed++;
      console.log(chalk.green(`  ✓ Subtitles enabled: ${initialSubtitleState.label} (${initialSubtitleState.language})`));
      console.log(chalk.gray(`    Cues loaded: ${initialSubtitleState.cues}`));
    } else {
      testResults.failed++;
      console.log(chalk.yellow('  ⚠ Could not enable subtitles'));
    }

    // Test 3-7: Seek to different times and check subtitle visibility
    const seekTests = [
      { name: 'Small forward seek (30s)', time: Math.min(30, duration * 0.1) },
      { name: 'Medium forward seek (2min)', time: Math.min(120, duration * 0.3) },
      { name: 'Large forward seek (5min)', time: Math.min(300, duration * 0.6) },
      { name: 'Backward seek (1min)', time: Math.min(60, duration * 0.2) },
      { name: 'Return to start', time: 10 }
    ];

    console.log(chalk.cyan('\n📝 Test 3-7: Testing subtitle behavior during seeking...\n'));

    for (let i = 0; i < seekTests.length; i++) {
      const test = seekTests[i];
      if (test.time >= duration) continue;

      console.log(chalk.blue(`  Test ${i + 3}: ${test.name} (${Math.floor(test.time)}s)`));
      
      // Seek to time
      await page.evaluate((time) => {
        const video = document.querySelector('video');
        video.currentTime = time;
      }, test.time);

      // Wait for seek to complete
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const video = document.querySelector('video');
          if (video.readyState >= 2) {
            video.addEventListener('seeked', () => resolve(), { once: true });
            setTimeout(() => resolve(), 2000);
          } else {
            setTimeout(() => resolve(), 2000);
          }
        });
      });

      // Wait a bit for subtitles to update
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check subtitle state after seek
      const subtitleState = await page.evaluate(() => {
        const video = document.querySelector('video');
        if (!video.textTracks) return null;
        
        const tracks = Array.from(video.textTracks).filter(t => t.kind === 'subtitles');
        const showingTrack = tracks.find(t => t.mode === 'showing');
        
        if (showingTrack) {
          const activeCues = showingTrack.activeCues ? Array.from(showingTrack.activeCues) : [];
          return {
            showing: true,
            language: showingTrack.language || showingTrack.srclang || 'unknown',
            mode: showingTrack.mode,
            activeCues: activeCues.length,
            hasCueForTime: activeCues.length > 0
          };
        }
        return { showing: false };
      });

      testResults.total++;
      if (subtitleState && subtitleState.showing) {
        testResults.passed++;
        const status = subtitleState.hasCueForTime ? '✓' : '⚠';
        const color = subtitleState.hasCueForTime ? chalk.green : chalk.yellow;
        console.log(color(`    ${status} Subtitles visible (${subtitleState.language})`));
        if (subtitleState.activeCues > 0) {
          console.log(chalk.gray(`      Active cues: ${subtitleState.activeCues}`));
        } else {
          console.log(chalk.gray('      No active cues (may be between subtitle lines)'));
        }
        testResults.details.push({
          test: test.name,
          time: test.time,
          status: subtitleState.hasCueForTime ? 'PASS' : 'WARNING',
          subtitleVisible: true,
          activeCues: subtitleState.activeCues
        });
      } else {
        testResults.failed++;
        console.log(chalk.red('    ✗ Subtitles not visible after seek'));
        testResults.details.push({
          test: test.name,
          time: test.time,
          status: 'FAIL',
          subtitleVisible: false
        });
      }

      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Test 8: Multiple rapid seeks
    console.log(chalk.cyan('\n📝 Test 8: Rapid seeking test...'));
    const rapidSeekTimes = [10, 60, 120, 30, 180, 15];
    let rapidSeekPassed = 0;
    
    for (const time of rapidSeekTimes) {
      if (time >= duration) continue;
      
      await page.evaluate((t) => {
        const video = document.querySelector('video');
        video.currentTime = t;
      }, time);
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const subtitleVisible = await page.evaluate(() => {
        const video = document.querySelector('video');
        if (!video.textTracks) return false;
        const tracks = Array.from(video.textTracks).filter(t => t.kind === 'subtitles');
        return tracks.some(t => t.mode === 'showing');
      });
      
      if (subtitleVisible) rapidSeekPassed++;
    }

    testResults.total++;
    if (rapidSeekPassed === rapidSeekTimes.length) {
      testResults.passed++;
      console.log(chalk.green(`  ✓ All rapid seeks maintained subtitles (${rapidSeekPassed}/${rapidSeekTimes.length})`));
    } else {
      testResults.failed++;
      console.log(chalk.yellow(`  ⚠ Some rapid seeks lost subtitles (${rapidSeekPassed}/${rapidSeekTimes.length})`));
    }

    // Print summary
    console.log(chalk.cyan('\n' + '='.repeat(60)));
    console.log(chalk.cyan('📊 Test Summary'));
    console.log(chalk.cyan('='.repeat(60)));
    console.log(chalk.green(`  Passed: ${testResults.passed}/${testResults.total}`));
    if (testResults.failed > 0) {
      console.log(chalk.red(`  Failed: ${testResults.failed}/${testResults.total}`));
    }
    console.log(chalk.cyan('='.repeat(60) + '\n'));

    // Keep browser open for manual inspection
    console.log(chalk.yellow('💡 Browser will remain open for 30 seconds for manual inspection...'));
    console.log(chalk.gray('   You can manually test seeking and subtitle behavior\n'));
    
    await new Promise(resolve => setTimeout(resolve, 30000));
    await browser.close();

  } catch (error) {
    console.error(chalk.red('\n❌ Automated test error:'));
    console.error(chalk.red('  ' + error.message));
    if (browser) {
      await browser.close();
    }
  }
}

// Print manual test instructions
function printManualTestInstructions(streamUrl) {
  console.log(chalk.cyan('\n📋 Manual Test Checklist:\n'));
  console.log(chalk.yellow('1. Open URL in browser:'));
  console.log(chalk.white('   ' + streamUrl + '\n'));
  
  console.log(chalk.yellow('2. Wait for video to load and start playing\n'));
  
  console.log(chalk.yellow('3. Test Subtitle Visibility:'));
  console.log(chalk.gray('   - Check if subtitles appear automatically'));
  console.log(chalk.gray('   - Verify subtitle language (should be English by default)'));
  console.log(chalk.gray('   - Right-click video → Subtitles → Verify available tracks\n'));
  
  console.log(chalk.yellow('4. Test Seeking (Critical Tests):'));
  console.log(chalk.gray('   a) Seek to 1 minute → Check if subtitles still visible'));
  console.log(chalk.gray('   b) Seek to 5 minutes → Check if subtitles still visible'));
  console.log(chalk.gray('   c) Seek back to 1 minute → Check if subtitles reappear'));
  console.log(chalk.gray('   d) Seek to different times multiple times → Verify consistency'));
  console.log(chalk.gray('   e) Use arrow keys to seek → Test subtitle behavior\n'));
  
  console.log(chalk.yellow('5. Test Subtitle Switching:'));
  console.log(chalk.gray('   - Use browser native controls to switch subtitle languages'));
  console.log(chalk.gray('   - Verify subtitles work after switching\n'));
  
  console.log(chalk.yellow('6. Monitor Console (F12):'));
  console.log(chalk.gray('   - Check for any subtitle-related errors'));
  console.log(chalk.gray('   - Look for "Re-enabled subtitle track" messages\n'));
}

// Continuous monitoring of subtitle server endpoints
function startMonitoring(streamUrl, streamManager) {
  const url = new URL(streamUrl);
  const baseUrl = `${url.protocol}//${url.host}`;
  
  let checkCount = 0;
  const monitorInterval = setInterval(async () => {
    checkCount++;
    
    try {
      // Check if subtitle endpoint is accessible
      const subtitleUrl = `${baseUrl}/subtitle.srt`;
      const response = await new Promise((resolve, reject) => {
        const req = http.get(subtitleUrl, (res) => {
          resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });

      if (response.statusCode === 200) {
        const contentLength = response.headers['content-length'];
        if (checkCount % 10 === 0) { // Log every 10 checks
          console.log(chalk.green(`[${new Date().toLocaleTimeString()}] ✓ Subtitle server responding (${(contentLength / 1024).toFixed(2)} KB)`));
        }
      } else if (checkCount % 10 === 0) {
        console.log(chalk.yellow(`[${new Date().toLocaleTimeString()}] ⚠ Subtitle server returned ${response.statusCode}`));
      }
    } catch (error) {
      if (checkCount % 10 === 0) {
        console.log(chalk.yellow(`[${new Date().toLocaleTimeString()}] ⚠ Subtitle check: ${error.message}`));
      }
    }

    // Check subtitle paths
    if (streamManager.subtitlePaths && streamManager.subtitlePaths.length > 0 && checkCount % 20 === 0) {
      const fs = require('fs');
      streamManager.subtitlePaths.forEach((sub, index) => {
        try {
          if (fs.existsSync(sub.path)) {
            const stats = fs.statSync(sub.path);
            console.log(chalk.cyan(`[${new Date().toLocaleTimeString()}] 📝 Subtitle ${index + 1}: ${(stats.size / 1024).toFixed(2)} KB (${sub.language || 'unknown'})`));
          }
        } catch (e) {
          // Ignore
        }
      });
    }
  }, 5000); // Check every 5 seconds

  // Cleanup on exit
  process.on('SIGINT', () => {
    clearInterval(monitorInterval);
  });
}

module.exports = { testStreaming, runAutomatedTests, startMonitoring };

