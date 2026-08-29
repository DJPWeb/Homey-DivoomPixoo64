'use strict';

const Homey    = require('homey');
const PixooApi = require('./lib/PixooApi');

class PixooApp extends Homey.App {

  async onInit() {
    this.log('Divoom Pixoo64 app has started.');

    this.homey.flow.getConditionCard('channel_is')
      .registerRunListener(async (args) => {
        const currentChannel = await PixooApi.getChannel(args.device.getSetting('ip'));
        return currentChannel === parseInt(args.channel, 10);
      });

    this.homey.flow.getActionCard('display_image')
      .registerRunListener(async (args) => {
        await PixooApi.sendImage(args.device.getSetting('ip'), args.url, args.frame);
      });

    this.homey.flow.getActionCard('display_apple_cover')
      .registerRunListener(async (args) => {
        const ip = args.device.getSetting('ip');
        // For Apple Music CDN URLs ending in .jpg/.jpeg, switch to .png variant.
        // Other URLs (Homey internal image proxy, etc.) are passed through unchanged.
        const url = args.url.replace(/\.jpe?g(?=[?#]|$)/i, '.png');
        await PixooApi.drawImageAt(ip, url, args.x, args.y, args.w, args.h);
      });

    this.homey.flow.getActionCard('display_text')
      .registerRunListener(async (args) => {
        await PixooApi.sendText(args.device.getSetting('ip'), args.text, args.color || '#FFFFFF', parseInt(args.font, 10));
      });

    this.homey.flow.getActionCard('set_channel')
      .registerRunListener(async (args) => {
        const channel = parseInt(args.channel, 10);
        if (typeof args.device.setChannel === 'function') {
          await args.device.setChannel(channel);
        } else {
          await PixooApi.setChannel(args.device.getSetting('ip'), channel);
        }
      });

    this.homey.flow.getActionCard('set_animation_mode')
      .registerRunListener(async (args) => {
        await PixooApi.setAnimationMode(args.device.getSetting('ip'), args.mode);
      });

    this.homey.flow.getActionCard('play_buzzer')
      .registerRunListener(async (args) => {
        await PixooApi.playBuzzer(args.device.getSetting('ip'), Math.round(args.duration) * 1000);
      });

    this.homey.flow.getActionCard('sync_time')
      .registerRunListener(async (args) => {
        await PixooApi.syncTime(args.device.getSetting('ip'));
      });

    this.homey.flow.getActionCard('show_scoreboard')
      .registerRunListener(async (args) => {
        await PixooApi.showScoreboard(args.device.getSetting('ip'), args.red, args.blue);
      });

    this.homey.flow.getActionCard('start_timer')
      .registerRunListener(async (args) => {
        await PixooApi.startTimer(args.device.getSetting('ip'), args.minutes, args.seconds);
      });

    this.homey.flow.getActionCard('stop_timer')
      .registerRunListener(async (args) => {
        await PixooApi.stopTimer(args.device.getSetting('ip'));
      });

    this.homey.flow.getActionCard('hold_display')
      .registerRunListener(async (args) => {
        PixooApi.holdDisplay(args.device.getSetting('ip'));
      });

    this.homey.flow.getActionCard('release_display')
      .registerRunListener(async (args) => {
        await PixooApi.releaseDisplay(args.device.getSetting('ip'));
      });

    this.homey.flow.getActionCard('fill_screen')
      .registerRunListener(async (args) => {
        await PixooApi.fillScreen(args.device.getSetting('ip'), args.color);
      });

    this.homey.flow.getActionCard('draw_rect')
      .registerRunListener(async (args) => {
        await PixooApi.drawRect(args.device.getSetting('ip'), args.x, args.y, args.w, args.h, args.color, args.opacity);
      });

    this.homey.flow.getActionCard('draw_pixel_text')
      .registerRunListener(async (args) => {
        await PixooApi.drawPixelText(args.device.getSetting('ip'), args.text, args.x, args.y, args.color, args.font);
      });

    // Homey Image objects for screenshot slots — created lazily, keyed by "ip_slot".
    const shotImages = new Map();
    const MAX_SHOT_IMAGES = 64;

    const touchShotImage = (key, image) => {
      if (shotImages.has(key)) shotImages.delete(key);
      shotImages.set(key, image);
      while (shotImages.size > MAX_SHOT_IMAGES) {
        const oldest = shotImages.keys().next().value;
        if (oldest === undefined) break;
        shotImages.delete(oldest);
      }
    };

    this.homey.flow.getActionCard('take_screenshot')
      .registerRunListener(async (args) => {
        const ip   = args.device.getSetting('ip');
        const slot = args.slot;
        await PixooApi.takeScreenshot(ip, slot);

        // Create or reuse a Homey Image for this slot so the screenshot is
        // accessible via the Homey Images API (visible in app, usable as token).
        const key = `${ip}_${slot}`;
        let img = shotImages.get(key);
        if (!img) {
          img = await this.homey.images.createImage();
          touchShotImage(key, img);
        } else {
          touchShotImage(key, img);
        }
        img.setPath(PixooApi.shotPath(ip, slot));
        await img.update();
      });

    this.homey.flow.getActionCard('display_screenshot')
      .registerRunListener(async (args) => {
        await PixooApi.displayScreenshot(args.device.getSetting('ip'), args.slot);
      });

    this.homey.flow.getActionCard('draw_text_at')
      .registerRunListener(async (args) => {
        await PixooApi.drawTextAt(args.device.getSetting('ip'), args.text, args.x, args.y, args.color, parseInt(args.font, 10), args.textId);
      });

    this.homey.flow.getActionCard('draw_image_at')
      .registerRunListener(async (args) => {
        await PixooApi.drawImageAt(args.device.getSetting('ip'), args.url, args.x, args.y, args.w, args.h);
      });

    this.homey.flow.getActionCard('clear_text_overlays')
      .registerRunListener(async (args) => {
        await PixooApi.clearTextOverlays(args.device.getSetting('ip'));
      });

    this.homey.flow.getActionCard('clean_display')
      .registerRunListener(async (args) => {
        await PixooApi.cleanDisplay(args.device.getSetting('ip'));
      });

    this.homey.flow.getActionCard('draw_lametric_icon')
      .registerRunListener(async (args) => {
        await PixooApi.drawLaMetricIcon(args.device.getSetting('ip'), args.id, args.x, args.y, args.frame, args.zoom);
      });

    this.log('Flow cards registered.');
  }

}

module.exports = PixooApp;
