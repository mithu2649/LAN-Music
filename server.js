import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import { Server } from 'socket.io';
import http from 'http';
import { exec, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

import player from 'play-sound';
const play = player();

import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get the directory name from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3330;
const QUEUE_FILE = 'queue.json';

app.use(bodyParser.json());
app.use(express.static('public'));

let queue = [];
let currentAudioProcess = null; 
let currentPlayingTitle = null;
let isPlaying = false;
let isPaused = false;


try {
  queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
} catch (err) {
  console.error('Could not load queue.json. Starting with empty queue.');
  queue = [];
}

function saveQueue() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function fetchTitle(link) {
  try {
    const response = await fetch(link);
    const html = await response.text();
    const $ = cheerio.load(html);
    const title = $('meta[name="title"]').attr('content');
    return title || 'Unknown Title';
  } catch (error) {
    console.error('Error fetching title:', error);
    return 'Unknown Title';
  }
}

let watchInterval = null;

function watchQueue() {
  if (watchInterval) clearInterval(watchInterval);
  watchInterval = setInterval(() => {
    if (!isPlaying && queue.length > 0) {
      console.log('New song detected in queue...');
      clearInterval(watchInterval);
      playNextSong();
    }
  }, 1000); // Check every 1 second
}


async function playNextSong() {
  if (queue.length === 0) {
    isPlaying = false;
    console.log('No songs in queue');
    watchQueue();
    return;
  }

  isPlaying = true;

  const link = queue[0].link; 
  const title = await fetchTitle(link); 
  queue.shift(); 
  saveQueue();

  io.emit('queueUpdate', queue); 

  const tempFile = path.join(os.tmpdir(), `yt_audio_${uuidv4()}.mp3`);
  const downloadCommand = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 -o "${tempFile}" "${link}"`;

  console.log('Downloading:', link);
  io.emit('playingNow', `<i class="fa-solid fa-spinner fa-spin"></i> ${title}`); 
  currentPlayingTitle = title;


  exec(downloadCommand, (error) => {
    if (error) {
      isPlaying = false;
      watchQueue();
      console.error('Download error:', error);
      return;
    }

    if (currentAudioProcess && !currentAudioProcess.killed) {
      currentAudioProcess.kill();
      console.log('Stopped previous song.');
    }

    console.log('Playing:', tempFile);
    currentAudioProcess = play.play(tempFile, (err) => {
      if (err) {
        console.error('Playback error:', err);
        return;
      }

      console.log('Playback finished for:', title);
      isPlaying = false;
      io.emit('playingNow', null); 
      fs.unlink(tempFile, () => {}); 

      if (queue.length > 0) {
        playNextSong();
      }else {
        watchQueue();
      }
    });

    io.emit('playingNow', `<i class="fa-solid fa-music"></i> ${title}`);
  });
}

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/public/admin.html'));


// Socket.io
io.on('connection', socket => {
  console.log('A user connected');

  socket.emit('queueUpdate', queue);
  if (currentPlayingTitle) {
    socket.emit('playingNow', `<i class="fa-solid fa-circle-play"></i> ${currentPlayingTitle}`);
  }

  socket.on('addSong', async (link) => {
    console.log(link)
    if (link && link.startsWith('http')) {
      const title = await fetchTitle(link);
      queue.push({ link, title }); 
      saveQueue();
      io.emit('queueUpdate', queue);

      if (!isPlaying) {
        playNextSong();
      }
    }
  });

  socket.on('playNext', () => {
    playNextSong(); 
  });

  socket.on('sendMessage', (data) => {
    io.emit('newMessage', data);
  
    const message = data.message;
    // Detect YouTube link
    const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = message.match(youtubeRegex);
  
    if (match && match[1]) {
      const cleanedUrl = `https://www.youtube.com/watch?v=${match[1]}`;
      console.log('YouTube link detected in message:', cleanedUrl);
  
      (async () => {
        const title = await fetchTitle(cleanedUrl);
        queue.push({ link: cleanedUrl, title });
        saveQueue();
        io.emit('queueUpdate', queue);
        if (!isPlaying) {
          playNextSong();
        }
      })();
    }
  
    // Handle 'next' or 'skip'
    if (message.trim().toLowerCase() === 'next' || message.trim().toLowerCase() === 'skip') {
      playNextSong();
    }
    //  // Pause
    // if (message === 'pause') {
    //   if (currentAudioProcess) {
    //     currentAudioProcess.stdin.write('set pause yes\n');
    //     isPaused = true;
    //     console.log('Paused music.');
    //   }
    // }

    // // Resume
    // if (message === 'play') {
    //   if (currentAudioProcess && currentAudioProcess.stdin) {
    //     currentAudioProcess.stdin.write('set pause no\n');
    //     isPaused = false;
    //     console.log('Resumed music.');
    //   }
    // }
  });
  
});


server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
