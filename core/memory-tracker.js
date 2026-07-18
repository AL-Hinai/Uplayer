'use strict';

// Memory diagnostics, opt-in behind --debug-memory. Samples process.memoryUsage() on a timer,
// warns past a threshold, and dumps a JSON report on stop. Isolated on purpose: nothing in the
// stream path depends on it, so it can be left out of a build entirely without consequence.
//
// IO: writes one report file (os.tmpdir()) and logs to the console. Owns a setInterval while
// enabled; stop() clears it.

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

class MemoryTracker {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.snapshots = [];
    this.maxSnapshots = 100;
    this.startTime = Date.now();
    this.startMemory = null;
    this.warningThreshold = 500 * 1024 * 1024; // 500MB warning
    this.criticalThreshold = 800 * 1024 * 1024; // 800MB critical
    this.interval = null;
    
    if (this.enabled) {
      this.startMemory = process.memoryUsage();
      console.log(chalk.cyan('\nMemory tracking enabled'));
      this.logMemory('Initial');
      
      // Start periodic monitoring
      this.interval = setInterval(() => {
        this.checkMemory();
      }, 5000); // Check every 5 seconds
    }
  }
  
  formatBytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }
  
  logMemory(label = 'Current') {
    if (!this.enabled) return;
    
    const usage = process.memoryUsage();
    const timestamp = Date.now() - this.startTime;
    
    const snapshot = {
      timestamp,
      label,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      arrayBuffers: usage.arrayBuffers
    };
    
    this.snapshots.push(snapshot);
    
    // Keep only last N snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    
    console.log(chalk.blue(`\n[${label}] Memory at ${(timestamp / 1000).toFixed(1)}s:`));
    console.log(chalk.white(`   Heap Used:     ${this.formatBytes(usage.heapUsed)}`));
    console.log(chalk.white(`   Heap Total:    ${this.formatBytes(usage.heapTotal)}`));
    console.log(chalk.white(`   RSS:           ${this.formatBytes(usage.rss)}`));
    console.log(chalk.white(`   External:      ${this.formatBytes(usage.external)}`));
    console.log(chalk.white(`   ArrayBuffers:  ${this.formatBytes(usage.arrayBuffers || 0)}`));
    
    // Calculate delta from start
    if (this.startMemory) {
      const delta = usage.heapUsed - this.startMemory.heapUsed;
      const deltaColor = delta > 0 ? chalk.red : chalk.green;
      console.log(deltaColor(`   Delta:         ${this.formatBytes(Math.abs(delta))} (${delta > 0 ? '+' : '-'})`));
    }
  }
  
  checkMemory() {
    if (!this.enabled) return;
    
    const usage = process.memoryUsage();
    
    // Warning threshold
    if (usage.heapUsed > this.warningThreshold && usage.heapUsed < this.criticalThreshold) {
      console.log(chalk.yellow(`\nMemory warning: ${this.formatBytes(usage.heapUsed)} heap used`));
      this.logMemory('Warning');
    }
    
    // Critical threshold
    if (usage.heapUsed > this.criticalThreshold) {
      console.log(chalk.red(`\nCRITICAL: High memory usage: ${this.formatBytes(usage.heapUsed)}`));
      this.logMemory('Critical');
      
      // Suggest actions
      console.log(chalk.yellow('   Suggestions:'));
      console.log(chalk.yellow('      - Stop and restart the current stream'));
      console.log(chalk.yellow('      - Pick a torrent with fewer/lighter files'));
      console.log(chalk.yellow('      - Close other applications'));
      console.log(chalk.yellow('      - Keep only one active player tab'));
    }
  }
  
  generateReport() {
    if (!this.enabled || this.snapshots.length === 0) return;
    
    console.log(chalk.cyan('\n\n' + '='.repeat(60)));
    console.log(chalk.cyan('MEMORY TRACKING REPORT'));
    console.log(chalk.cyan('='.repeat(60)));
    
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const peak = this.snapshots.reduce((max, s) => s.heapUsed > max.heapUsed ? s : max, first);
    
    console.log(chalk.white('\nSummary:'));
    console.log(chalk.white(`   Duration:      ${(last.timestamp / 1000 / 60).toFixed(1)} minutes`));
    console.log(chalk.white(`   Snapshots:     ${this.snapshots.length}`));
    console.log(chalk.white(`   Start Memory:  ${this.formatBytes(first.heapUsed)}`));
    console.log(chalk.white(`   End Memory:    ${this.formatBytes(last.heapUsed)}`));
    console.log(chalk.white(`   Peak Memory:   ${this.formatBytes(peak.heapUsed)} at ${(peak.timestamp / 1000).toFixed(1)}s`));
    
    const growth = last.heapUsed - first.heapUsed;
    const growthRate = (growth / last.timestamp) * 1000; // bytes per second
    
    if (growth > 0) {
      console.log(chalk.red(`   Memory Growth: +${this.formatBytes(growth)}`));
      console.log(chalk.yellow(`   Growth Rate:   ${this.formatBytes(growthRate)}/sec`));
      
      // Estimate time to crash
      const remainingMemory = this.criticalThreshold - last.heapUsed;
      if (growthRate > 0 && remainingMemory > 0) {
        const timeToFull = remainingMemory / growthRate;
        console.log(chalk.red(`   Est. Crash In: ${(timeToFull / 60).toFixed(1)} minutes (if growth continues)`));
      }
    } else {
      console.log(chalk.green(`   Memory Growth: ${this.formatBytes(growth)} (stable)`));
    }
    
    // Identify potential issues
    console.log(chalk.white('\nPotential Issues:'));
    
    const avgArrayBuffers = this.snapshots.reduce((sum, s) => sum + (s.arrayBuffers || 0), 0) / this.snapshots.length;
    if (avgArrayBuffers > 100 * 1024 * 1024) {
      console.log(chalk.yellow(`   High ArrayBuffer usage (${this.formatBytes(avgArrayBuffers)})`));
      console.log(chalk.yellow('      ? Likely video buffering issue'));
      console.log(chalk.yellow('      ? Restart stream and choose a higher-seeder torrent'));
    }
    
    const avgExternal = this.snapshots.reduce((sum, s) => sum + s.external, 0) / this.snapshots.length;
    if (avgExternal > 200 * 1024 * 1024) {
      console.log(chalk.yellow(`   High external memory (${this.formatBytes(avgExternal)})`));
      console.log(chalk.yellow('      ? Likely WebTorrent buffering'));
      console.log(chalk.yellow('      ? Reduce peer connections'));
    }
    
    if (growth > 100 * 1024 * 1024) {
      console.log(chalk.red(`   Memory leak detected!`));
      console.log(chalk.yellow('      ? Memory growing over time'));
      console.log(chalk.yellow('      ? Check browser developer console for errors'));
    }
    
    // Save to file
    const reportPath = path.join(require('os').tmpdir(), `stream-memory-report-${Date.now()}.json`);
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        summary: {
          duration: last.timestamp,
          snapshots: this.snapshots.length,
          startMemory: first.heapUsed,
          endMemory: last.heapUsed,
          peakMemory: peak.heapUsed,
          growth,
          growthRate
        },
        snapshots: this.snapshots
      }, null, 2));
      console.log(chalk.green(`\nReport saved: ${reportPath}`));
    } catch (err) {
      console.log(chalk.red(`\n? Could not save report: ${err.message}`));
    }
    
    console.log(chalk.cyan('\n' + '='.repeat(60) + '\n'));
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.enabled) {
      this.logMemory('Final');
      this.generateReport();
    }
  }
}


function createMemoryTracker(enabled = false) {
  return new MemoryTracker(enabled);
}

module.exports = { MemoryTracker, createMemoryTracker };
